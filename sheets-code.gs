// Global Constants
const BACKEND_URL = 'https://zany-meme-4x75j674p7wfj574-3000.app.github.dev';
const MIN_POLL_INTERVAL = 1000;
const MAX_POLL_INTERVAL = 30000;
const BACKOFF_MULTIPLIER = 1.5;
const MAX_RETRIES = 3;

// Enhanced Global State
let globalState = {
  document: null,
  selectedRange: null,
  remoteSelection: null,
  connections: [],
  lastUpdateTimestamp: Date.now(),
  autoUpdate: true,
  currentPollInterval: MIN_POLL_INTERVAL,
  pollTimeoutId: null,
  lastUpdateReceived: Date.now(),
  lastSyncTime: Date.now(),
  initialized: false,
  initializationError: null,
  selectionTrackingActive: false,
  retryCount: 0,
  isPolling: false,
  consecutiveFailures: 0,
  maxConsecutiveFailures: 5,
  reconnectAttempts: 0,
  maxReconnectAttempts: 3,
  lastError: null,
  pendingUpdates: [],
  connectionStatus: 'disconnected' // 'connected', 'disconnected', 'error'
};

// UI Setup
function onOpen(e) {
  SpreadsheetApp.getUi()
    .createMenu('Hive Theory')
    .addItem('Show Sidebar', 'showSidebar')
    .addToUi();
}

function showSidebar() {
  const html = HtmlService.createHtmlOutputFromFile('sidebar')
    .setTitle('Hive Theory')
    .setWidth(300);
  SpreadsheetApp.getUi().showSidebar(html);
}

// Enhanced API Communication
function makeRequest(endpoint, method = 'GET', payload = null, retryCount = 0) {
  const options = {
    method: method,
    headers: {
      'Content-Type': 'application/json',
    },
    muteHttpExceptions: true
  };

  if (payload) {
    options.payload = JSON.stringify(payload);
  }

  try {
    const response = UrlFetchApp.fetch(`${BACKEND_URL}/api/${endpoint}`, options);
    const responseCode = response.getResponseCode();
    
    if (responseCode !== 200) {
      if (responseCode >= 500 && retryCount < MAX_RETRIES) {
        Utilities.sleep(1000 * Math.pow(2, retryCount)); // Exponential backoff
        return makeRequest(endpoint, method, payload, retryCount + 1);
      }
      throw new Error(`HTTP ${responseCode}: ${response.getContentText()}`);
    }
    
    return JSON.parse(response.getContentText());
  } catch (error) {
    console.error('API request failed:', error);
    if (retryCount < MAX_RETRIES) {
      Utilities.sleep(1000 * Math.pow(2, retryCount));
      return makeRequest(endpoint, method, payload, retryCount + 1);
    }
    throw error;
  }
}

// Improved State Management
function initializeState() {
  if (globalState.initialized) {
    return {
      success: true,
      connections: globalState.connections
    };
  }

  try {
    const response = makeRequest('register', 'POST', { type: 'sheets' });
    
    if (!response || !response.success) {
      throw new Error(response?.error || 'Registration failed');
    }

    globalState = {
      ...globalState,
      connections: response.initialState.connections || [],
      lastUpdateTimestamp: Date.now(),
      initialized: true,
      initializationError: null
    };

    // Start selection tracking immediately - users need this regardless of connections
    try {
      startSelectionTracking();
      globalState.selectionTrackingActive = true;
    } catch (error) {
      console.error('Selection tracking failed to start:', error);
      // This is critical for user experience, so we should report it
      throw new Error('Failed to initialize selection tracking: ' + error.message);
    }

    // Always start polling - we need to be ready for connections
    startPolling();

    // If we have existing connections, protect those cells
    if (response.initialState.connections.length > 0) {
      try {
        protectConnectedCells();
      } catch (error) {
        console.error('Failed to protect cells:', error);
        // Notify user but don't fail initialization
      }
    }

    return {
      success: true,
      connections: response.initialState.connections || []
    };
  } catch (error) {
    globalState.initializationError = error.message;
    console.error('Failed to initialize state:', error);
    return {
      success: false,
      error: error.message || 'Failed to initialize state'
    };
  }
}

// Improved Selection Tracking
function startSelectionTracking() {
  if (globalState.selectionTrackingActive) {
    return;
  }

  try {
    // Run initial selection check
    trackSelection();
    
    const sheet = SpreadsheetApp.getActiveSpreadsheet();
    const triggers = ScriptApp.getUserTriggers(sheet);
    
    // Remove any existing selection triggers
    triggers.forEach(trigger => {
      if (trigger.getEventType() === ScriptApp.EventType.ON_SELECTION_CHANGE) {
        ScriptApp.deleteTrigger(trigger);
      }
    });
    
    // Create new selection trigger
    ScriptApp.newTrigger('onSelectionChange')
      .forSpreadsheet(sheet)
      .onSelectionChange()
      .create();

    globalState.selectionTrackingActive = true;
  } catch (error) {
    console.error('Failed to start selection tracking:', error);
    globalState.selectionTrackingActive = false;
    throw error;
  }
}

// Improved Polling Mechanism
function startPolling() {
  if (globalState.isPolling) {
    return;
  }

  globalState.isPolling = true;
  globalState.currentPollInterval = MIN_POLL_INTERVAL;
  pollForUpdates();
}

function stopPolling() {
  globalState.isPolling = false;
  globalState.currentPollInterval = MIN_POLL_INTERVAL;
}

function pollForUpdates() {
  if (!globalState.autoUpdate || !globalState.isPolling) {
    globalState.isPolling = false;
    globalState.connectionStatus = 'disconnected';
    return;
  }

  try {
    const updates = makeRequest(
      `updates/sheets?lastUpdate=${globalState.lastUpdateTimestamp}`
    );

    // Update connection status on successful poll
    globalState.connectionStatus = 'connected';
    globalState.consecutiveFailures = 0;
    globalState.lastSyncTime = Date.now();

    if (updates?.updates?.length > 0) {
      const updateIds = [];
      
      updates.updates.forEach(update => {
        try {
          updateIds.push(update.id);
          handleUpdate(update);
        } catch (error) {
          console.error('Error handling update:', error);
        }
      });

      if (updateIds.length > 0) {
        try {
          makeRequest('updates/acknowledge', 'POST', { updateIds });
        } catch (error) {
          console.error('Failed to acknowledge updates:', error);
        }
      }

      globalState.lastUpdateTimestamp = Date.now();
      globalState.lastUpdateReceived = Date.now();
      globalState.currentPollInterval = MIN_POLL_INTERVAL;
    } else {
      globalState.currentPollInterval = Math.min(
        globalState.currentPollInterval * BACKOFF_MULTIPLIER,
        MAX_POLL_INTERVAL
      );
    }

    if (globalState.isPolling) {
      Utilities.sleep(globalState.currentPollInterval);
      pollForUpdates();
    }
  } catch (error) {
    console.error('Error polling for updates:', error);
    globalState.connectionStatus = 'error';
    globalState.currentPollInterval = MAX_POLL_INTERVAL;
    handleConnectionFailure();
    
    if (globalState.isPolling) {
      Utilities.sleep(globalState.currentPollInterval);
      pollForUpdates();
    }
  }
}

// Selection Tracking
function trackSelection() {
  try {
    const selection = SpreadsheetApp.getActiveRange();
    if (!selection) {
      makeRequest('selection/sheets/broadcast', 'POST', {
        selection: null,
        timestamp: Date.now()
      });
      return null;
    }

    const selectionData = {
      spreadsheetId: SpreadsheetApp.getActiveSpreadsheet().getId(),
      sheetName: selection.getSheet().getName(),
      range: selection.getA1Notation(),
      numRows: selection.getNumRows(),
      numColumns: selection.getNumColumns(),
      timestamp: Date.now(),
      active: true,
      syncEnabled: true
    };

    globalState.selectedRange = selectionData;
    globalState.lastSyncTime = Date.now();

    // Broadcast with retries
    let broadcastAttempts = 0;
    while (broadcastAttempts < MAX_RETRIES) {
      try {
        makeRequest('selection/sheets/broadcast', 'POST', {
          selection: selectionData,
          timestamp: Date.now()
        });
        break;
      } catch (error) {
        broadcastAttempts++;
        if (broadcastAttempts === MAX_RETRIES) {
          console.error('Failed to broadcast selection after multiple attempts:', error);
        } else {
          Utilities.sleep(100 * Math.pow(2, broadcastAttempts));
        }
      }
    }

    return selectionData;
  } catch (error) {
    console.error('Error tracking selection:', error);
    return null;
  }
}

function onSelectionChange(e) {
  if (!e) return;
  
  try {
    const range = e.range;
    const sheet = e.source.getActiveSheet();
    const selectionData = {
      spreadsheetId: sheet.getParent().getId(),
      sheetName: sheet.getName(),
      range: range.getA1Notation(),
      numRows: range.getNumRows(),
      numColumns: range.getNumColumns(),
      timestamp: Date.now(),
      active: true,
      syncEnabled: true
    };

    globalState.selectedRange = selectionData;
    globalState.lastSyncTime = Date.now();

    // Broadcast with retries
    let broadcastAttempts = 0;
    while (broadcastAttempts < MAX_RETRIES) {
      try {
        makeRequest('selection/sheets/broadcast', 'POST', {
          selection: selectionData,
          timestamp: Date.now()
        });
        break;
      } catch (error) {
        broadcastAttempts++;
        if (broadcastAttempts === MAX_RETRIES) {
          console.error('Failed to broadcast selection after multiple attempts:', error);
        } else {
          Utilities.sleep(100 * Math.pow(2, broadcastAttempts));
        }
      }
    }
  } catch (error) {
    console.error('Error in onSelectionChange:', error);
  }
}

// Update Handling
function handleUpdate(update) {
  try {
    if (!update || !update.type || !update.content) {
      console.error('Invalid update format:', update);
      return;
    }

    const content = typeof update.content === 'string' ? 
      JSON.parse(update.content) : update.content;

    switch (update.type) {
      case 'selection':
        handleRemoteSelection(content);
        break;
      case 'connection':
        handleConnectionChange(content);
        break;
      case 'value':
        handleValueUpdate(content);
        break;
      default:
        console.warn('Unknown update type:', update.type);
    }
  } catch (error) {
    console.error('Error handling update:', error);
    handleConnectionFailure();
  }
}

function handleRemoteSelection(data) {
  if (!data?.elementId) return;

  try {
    globalState.remoteSelection = {
      ...data,
      receivedAt: Date.now()
    };

    const connection = globalState.connections.find(c => c.slideElementId === data.elementId);
    if (connection) {
      const sheet = SpreadsheetApp.getActiveSheet();
      const range = sheet.getRange(connection.cellId);
      const originalBackground = range.getBackground();
      range.setBackground('#ff4081');
      
      Utilities.sleep(2000);
      range.setBackground(originalBackground);

      if (globalState.selectedRange) {
        makeRequest('selection/sheets/broadcast', 'POST', {
          selection: {
            ...globalState.selectedRange,
            timestamp: Date.now()
          }
        });
      }
    }

    globalState.lastSyncTime = Date.now();
  } catch (error) {
    console.error('Error handling remote selection:', error);
  }
}

// Cell Protection
function protectCell(cellId) {
  try {
    const [sheetName, range] = cellId.split('!');
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
    if (!sheet) return;

    const rangeObj = sheet.getRange(range);
    const protection = rangeObj.protect();
    protection.setDescription('Connected to Slides element');
    protection.setWarningOnly(true);
  } catch (error) {
    console.error('Error protecting cell:', error);
  }
}

function protectConnectedCells() {
  globalState.connections.forEach(connection => {
    protectCell(connection.cellId);
  });
}

// Connection Management
function handleConnectionChange(connection) {
  if (!connection?.cellId) return;

  try {
    const hadNoConnections = globalState.connections.length === 0;
    globalState.connections = globalState.connections.filter(
      c => c.cellId !== connection.cellId
    ).concat([connection]);
    
    protectCell(connection.cellId);
    globalState.lastSyncTime = Date.now();
  } catch (error) {
    console.error('Error handling connection change:', error);
  }
}

// Value Updates
function handleValueUpdate(data) {
  if (!data?.cellId) return;

  try {
    const [sheetName, range] = data.cellId.split('!');
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
    if (sheet) {
      sheet.getRange(range).setValue(data.value);
      globalState.lastSyncTime = Date.now();
    }
  } catch (error) {
    console.error('Error handling value update:', error);
  }
}

// Utility Functions
function getCurrentState() {
  return globalState;
}

function setAutoUpdate(enabled) {
  globalState.autoUpdate = enabled;
  if (enabled) {
    startPolling();
  } else {
    stopPolling();
  }
}

// Connection Management
function createConnection(cellId, slideElementId) {
  try {
    if (!validateCell(cellId)) {
      throw new Error('Invalid cell selection');
    }

    const payload = {
      cellId,
      slideElementId,
      timestamp: Date.now()
    };

    const response = makeRequest('connections', 'POST', payload);
    if (response.success) {
      const connection = response.connection;
      globalState.connections.push(connection);
      protectCell(connection.cellId);
      globalState.lastSyncTime = Date.now();
      showUserFeedback('Connection created successfully', 'success');
    }
    return response;
  } catch (error) {
    console.error('Error creating connection:', error);
    showUserFeedback('Failed to create connection: ' + error.message, 'error');
    throw error;
  }
}

function removeConnection(connectionId) {
  try {
    const connection = globalState.connections.find(c => c.id === connectionId);
    if (!connection) {
      throw new Error('Connection not found');
    }

    const response = makeRequest(`connections/${connectionId}`, 'DELETE');
    if (response.success) {
      removeProtection(connection.cellId);
      globalState.connections = globalState.connections.filter(c => c.id !== connectionId);
      globalState.lastSyncTime = Date.now();
      showUserFeedback('Connection removed successfully', 'success');
    }
    return response;
  } catch (error) {
    console.error('Error removing connection:', error);
    showUserFeedback('Failed to remove connection: ' + error.message, 'error');
    throw error;
  }
}

function validateCell(cellId) {
  try {
    const [sheetName, range] = cellId.split('!');
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
    if (!sheet) {
      return false;
    }
    try {
      sheet.getRange(range);
      return true;
    } catch (e) {
      return false;
    }
  } catch (error) {
    console.error('Cell validation failed:', error);
    return false;
  }
}

function removeProtection(cellId) {
  try {
    const [sheetName, range] = cellId.split('!');
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
    if (!sheet) return;

    const rangeObj = sheet.getRange(range);
    const protections = rangeObj.getProtections(SpreadsheetApp.ProtectionType.RANGE);
    protections.forEach(protection => {
      if (protection.getDescription() === 'Connected to Slides element') {
        protection.remove();
      }
    });
  } catch (error) {
    console.error('Error removing protection:', error);
  }
}

function showUserFeedback(message, type = 'info') {
  try {
    const ui = SpreadsheetApp.getUi();
    switch(type) {
      case 'error':
        ui.alert('Error', message, ui.ButtonSet.OK);
        break;
      case 'warning':
        ui.alert('Warning', message, ui.ButtonSet.OK);
        break;
      case 'success':
        // For success, we might want to use a more subtle approach
        console.log('Success:', message);
        break;
      default:
        ui.alert('Info', message, ui.ButtonSet.OK);
    }
  } catch (error) {
    console.error('Failed to show feedback:', error);
  }
}

// Add Enhanced Error Recovery to sheets-code.gs
function handleConnectionFailure() {
  try {
    globalState.consecutiveFailures++;
    console.error(`Connection failure (attempt ${globalState.consecutiveFailures})`);

    if (globalState.consecutiveFailures >= globalState.maxConsecutiveFailures) {
      if (globalState.reconnectAttempts < globalState.maxReconnectAttempts) {
        globalState.reconnectAttempts++;
        console.log(`Attempting reconnection (${globalState.reconnectAttempts}/${globalState.maxReconnectAttempts})`);
        globalState.initialized = false;
        return initializeState();
      } else {
        console.error('Max reconnection attempts reached');
        showUserFeedback('Connection lost. Please refresh the sidebar.', 'error');
        stopPolling();
      }
    }
    return null;
  } catch (error) {
    console.error('Error in handleConnectionFailure:', error);
    return null;
  }
}

// Add cleanup function to sheets-code.gs
function cleanup() {
  try {
    stopPolling();
    globalState.connections.forEach(connection => {
      removeProtection(connection.cellId);
    });
    globalState = {
      ...globalState,
      connections: [],
      initialized: false,
      selectionTrackingActive: false,
      isPolling: false
    };
  } catch (error) {
    console.error('Error in cleanup:', error);
  }
}

// Update makeRequest in sheets-code.gs to match slides implementation
function makeRequest(endpoint, method, data = {}) {
  try {
    const options = {
      method: method,
      contentType: 'application/json',
      payload: JSON.stringify(data),
      muteHttpExceptions: true
    };

    const response = UrlFetchApp.fetch(BACKEND_URL + '/' + endpoint, options);
    const jsonResponse = JSON.parse(response.getContentText());

    if (jsonResponse.error) {
      console.error('API error:', jsonResponse.error);
      throw new Error(jsonResponse.error);
    }

    return jsonResponse;
  } catch (error) {
    console.error('API request failed:', error);
    throw error;
  }
}

// Add validateRange function to match slides' validateElement
function validateRange(range) {
  if (!range) return false;
  try {
    const sheet = range.getSheet();
    const a1Notation = range.getA1Notation();
    return sheet && a1Notation;
  } catch (error) {
    console.error('Range validation failed:', error);
    return false;
  }
}
