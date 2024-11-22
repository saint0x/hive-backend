// Global Constants
const BACKEND_URL = 'https://zany-meme-4x75j674p7wfj574-3000.app.github.dev';
const MIN_POLL_INTERVAL = 1000; // Match server's MIN_UPDATE_INTERVAL_MS
const MAX_POLL_INTERVAL = 30000; // 30 seconds maximum
const BACKOFF_MULTIPLIER = 1.5; // Increase interval by 50% when no updates

// Global state
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
  lastSyncTime: Date.now() // Track last sync time
};

// UI Setup
function onOpen(e) {
  SpreadsheetApp.getUi()
    .createMenu('Hive Theory')
    .addItem('Show Sidebar', 'showSidebar')
    .addToUi();
  startPolling();
}

function showSidebar() {
  const html = HtmlService.createHtmlOutputFromFile('sidebar')
    .setTitle('Hive Theory')
    .setWidth(300);
  SpreadsheetApp.getUi().showSidebar(html);
}

// API Communication
function makeRequest(endpoint, method = 'GET', payload = null) {
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
    return JSON.parse(response.getContentText());
  } catch (error) {
    console.error('API request failed:', error);
    throw error;
  }
}

// State Management
function initializeState() {
  try {
    const response = makeRequest('register', 'POST', { type: 'sheets' });
    if (response.success) {
      globalState = {
        ...globalState,
        connections: response.initialState.connections,
        lastUpdateTimestamp: Date.now()
      };

      // Start selection tracking immediately
      startSelectionTracking();

      // Only start polling if we have active connections
      if (response.initialState.connections.length > 0) {
        startPolling();
        // Protect all connected cells
        protectConnectedCells();
      }

      // Return format matching what sidebar expects
      return {
        success: true,
        connections: response.initialState.connections || []
      };
    }

    // Return format matching what sidebar expects
    return {
      success: false,
      error: 'Server registration failed'
    };
  } catch (error) {
    console.error('Failed to initialize state:', error);
    // Return format matching what sidebar expects
    return {
      success: false,
      error: error.message || 'Failed to initialize state'
    };
  }
}

// Selection Tracking
function startSelectionTracking() {
  // Run initial selection check
  trackSelection();
  
  // Set up continuous selection tracking
  const sheet = SpreadsheetApp.getActiveSpreadsheet();
  const triggers = ScriptApp.getUserTriggers(sheet);
  
  // Remove any existing selection triggers to avoid duplicates
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
}

function trackSelection() {
  const selection = SpreadsheetApp.getActiveRange();
  if (!selection) {
    // Even when nothing is selected, broadcast null selection
    makeRequest(`selection/sheets/broadcast`, 'POST', {
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

  // Update local state
  globalState.selectedRange = selectionData;
  globalState.lastSyncTime = Date.now();

  // Always broadcast selection, regardless of connection status
  makeRequest(`selection/sheets/broadcast`, 'POST', {
    selection: selectionData,
    timestamp: Date.now()
  });

  return selectionData;
}

function onSelectionChange(e) {
  if (!e) return;
  
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

  // Update local state
  globalState.selectedRange = selectionData;
  globalState.lastSyncTime = Date.now();

  // Always broadcast selection, even before any connections exist
  makeRequest(`selection/sheets/broadcast`, 'POST', {
    selection: selectionData,
    timestamp: Date.now()
  });
}

// Optimized Update Polling
function startPolling() {
  if (globalState.pollTimeoutId) {
    // Clear existing timeout to avoid duplicates
    clearTimeout(globalState.pollTimeoutId);
    globalState.pollTimeoutId = null;
  }
  
  // Always poll regardless of connections
  pollForUpdates();
}

function stopPolling() {
  if (globalState.pollTimeoutId) {
    clearTimeout(globalState.pollTimeoutId);
    globalState.pollTimeoutId = null;
  }
}

function adjustPollInterval(hadUpdates) {
  if (hadUpdates) {
    // Reset to minimum interval when updates are found
    globalState.currentPollInterval = MIN_POLL_INTERVAL;
  } else {
    // Increase interval when no updates (with maximum limit)
    globalState.currentPollInterval = Math.min(
      globalState.currentPollInterval * BACKOFF_MULTIPLIER,
      MAX_POLL_INTERVAL
    );
  }
}

function pollForUpdates() {
  if (!globalState.autoUpdate) return;

  try {
    const updates = makeRequest(
      `updates/sheets?lastUpdate=${globalState.lastUpdateTimestamp}`
    );

    let hadUpdates = false;
    if (updates.updates?.length > 0) {
      hadUpdates = true;
      const updateIds = [];
      
      updates.updates.forEach(update => {
        updateIds.push(update.id);
        handleUpdate(update);
      });

      // Acknowledge processed updates
      makeRequest('updates/acknowledge', 'POST', { updateIds });
      
      globalState.lastUpdateTimestamp = Date.now();
      globalState.lastUpdateReceived = Date.now();
      globalState.lastSyncTime = Date.now();
    }

    // Adjust polling interval based on update activity
    adjustPollInterval(hadUpdates);

    // Schedule next poll
    globalState.pollTimeoutId = setTimeout(pollForUpdates, globalState.currentPollInterval);
  } catch (error) {
    console.error('Error polling for updates:', error);
    // On error, use maximum interval before retry
    globalState.currentPollInterval = MAX_POLL_INTERVAL;
    globalState.pollTimeoutId = setTimeout(pollForUpdates, globalState.currentPollInterval);
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
  }
}

function handleRemoteSelection(data) {
  if (!data?.elementId) return;

  try {
    // Store remote selection with timestamp
    globalState.remoteSelection = {
      ...data,
      receivedAt: Date.now(),
      active: true,
      syncEnabled: true
    };

    // Find any connections related to this element
    const connection = globalState.connections.find(c => c.slideElementId === data.elementId);
    if (connection) {
      const sheet = SpreadsheetApp.getActiveSheet();
      const range = sheet.getRange(connection.cellId);
      const originalBackground = range.getBackground();
      range.setBackground('#ff4081'); // Pink highlight to match slides
      
      // Reset background after 2 seconds
      Utilities.sleep(2000);
      range.setBackground(originalBackground);

      // Update last sync time
      makeRequest(`connections/${connection.id}`, 'PUT', {
        lastSyncTime: Date.now()
      });

      // Broadcast our current selection in response
      if (globalState.selectedRange) {
        makeRequest('selection/sheets/broadcast', 'POST', {
          selection: {
            ...globalState.selectedRange,
            timestamp: Date.now()
          }
        });
      }
    }
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
    protection.setWarningOnly(true); // Allow edits but show warning
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
function createConnection(cellId, slideElementId) {
  try {
    // Validate connection parameters
    if (!cellId || typeof cellId !== 'string' || !cellId.includes('!')) {
      throw new Error('Cell ID must be in format: SheetName!CellReference');
    }
    if (!slideElementId || typeof slideElementId !== 'string') {
      throw new Error('Slide element ID is required and must be a string');
    }

    const response = makeRequest('connections', 'POST', {
      cellId,
      slideElementId
    });
    
    if (response.success) {
      const hadNoConnections = globalState.connections.length === 0;
      globalState.connections.push(response.connection);
      
      // Protect the cell
      protectCell(cellId);
      
      // Start polling if this is our first connection
      if (hadNoConnections) {
        startPolling();
      }
    }
    
    return response;
  } catch (error) {
    console.error('Error creating connection:', error);
    return { success: false, error: error.message };
  }
}

// Handle cell value changes
function onEdit(e) {
  if (!e || !globalState.autoUpdate) return;

  const range = e.range;
  const sheet = e.source.getActiveSheet();
  const cellId = `${sheet.getName()}!${range.getA1Notation()}`;

  // Check if edited cell has a connection
  const connection = globalState.connections.find(c => c.cellId === cellId);
  if (!connection) return;

  // Get the cell's current value
  const value = range.getValue();

  // Notify server of change
  makeRequest('updates/cell', 'POST', {
    connectionId: connection.id,
    value: value,
    timestamp: Date.now()
  });
}

function handleConnectionChange(connection) {
  if (!connection?.cellId) return;

  try {
    // Update connections and manage polling
    const hadNoConnections = globalState.connections.length === 0;
    globalState.connections = globalState.connections.filter(
      c => c.cellId !== connection.cellId
    ).concat([connection]);
    
    // Protect the cell
    protectCell(connection.cellId);
    
    // Start polling if this is our first connection
    if (hadNoConnections && globalState.connections.length > 0) {
      startPolling();
    }
  } catch (error) {
    console.error('Error handling connection change:', error);
  }
}

// Utility Functions
function getCurrentState() {
  return globalState;
}

function setAutoUpdate(enabled) {
  globalState.autoUpdate = enabled;
  if (enabled && globalState.connections.length > 0) {
    startPolling();
  } else if (!enabled) {
    stopPolling();
  }
}

// Handle value updates from slides
function handleValueUpdate(data) {
  if (!data?.cellId) return;

  try {
    const [sheetName, range] = data.cellId.split('!');
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
    if (sheet) {
      sheet.getRange(range).setValue(data.value);
    }
  } catch (error) {
    console.error('Error handling value update:', error);
  }
}
