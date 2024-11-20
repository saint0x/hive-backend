// Global Constants
const BACKEND_URL = 'https://zany-meme-4x75j674p7wfj574-3000.app.github.dev';
const MIN_POLL_INTERVAL = 5000; // 5 seconds minimum
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
  lastUpdateReceived: Date.now()
};

// UI Setup
function onOpen(e) {
  SpreadsheetApp.getUi()
    .createMenu('Hive Theory')
    .addItem('Show Sidebar', 'showSidebar')
    .addToUi();
}

function showSidebar() {
  const html = HtmlService.createHtmlOutputFromFile('sheets-sidebar')
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

      // Only start polling if we have active connections
      if (response.initialState.connections.length > 0) {
        startPolling();
        // Protect all connected cells
        protectConnectedCells();
      }
      return true;
    }
    return false;
  } catch (error) {
    console.error('Failed to initialize state:', error);
    return false;
  }
}

// Selection Tracking
function trackSelection() {
  const selection = SpreadsheetApp.getActiveRange();
  if (!selection) return null;

  const selectionData = {
    spreadsheetId: SpreadsheetApp.getActiveSpreadsheet().getId(),
    sheetName: selection.getSheet().getName(),
    range: selection.getA1Notation(),
    numRows: selection.getNumRows(),
    numColumns: selection.getNumColumns()
  };

  // Update local state
  globalState.selectedRange = selectionData;

  // Broadcast selection
  makeRequest(`selection/sheets/broadcast`, 'POST', {
    selection: selectionData
  });

  return selectionData;
}

// Cell Movement Handling
function onCellMove(e) {
  if (!e) return;
  
  const oldRange = e.oldRange;
  const newRange = e.newRange;
  const sheet = e.source.getActiveSheet();
  
  // Find any connections for the moved cell
  const oldCellId = `${sheet.getName()}!${oldRange.getA1Notation()}`;
  const connection = globalState.connections.find(c => c.cellId === oldCellId);
  
  if (connection) {
    const newCellId = `${sheet.getName()}!${newRange.getA1Notation()}`;
    
    // Update connection with new cell ID
    makeRequest(`connections/${connection.id}`, 'PUT', {
      cellId: newCellId,
      active: true,
      syncEnabled: true
    });
    
    // Update local state
    connection.cellId = newCellId;
    
    // Re-protect the cell in its new location
    protectCell(newCellId);
    
    // Notify UI of the change
    SpreadsheetApp.getUi().alert(
      'Connection Updated',
      `Connection moved from ${oldCellId} to ${newCellId}`,
      SpreadsheetApp.getUi().ButtonSet.OK
    );
  }
}

// Optimized Update Polling
function startPolling() {
  if (!globalState.autoUpdate || globalState.pollTimeoutId) return;
  
  // Only poll if we have active connections
  if (globalState.connections.length === 0) {
    console.log('No active connections, stopping polling');
    return;
  }

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
    switch (update.type) {
      case 'selection':
        handleRemoteSelection(update.content);
        break;
      case 'connection':
        handleConnectionChange(update.content);
        break;
    }
  } catch (error) {
    console.error('Error handling update:', error);
  }
}

function handleRemoteSelection(data) {
  if (!data?.elementId) return;

  try {
    // Store remote selection for UI
    globalState.remoteSelection = data;

    // Find any connections related to this element
    const connection = globalState.connections.find(c => c.slideElementId === data.elementId);
    if (connection) {
      const sheet = SpreadsheetApp.getActiveSheet();
      const range = sheet.getRange(connection.cellId);
      const originalBackground = range.getBackground();
      range.setBackground('#e6f3ff'); // Light blue highlight
      
      // Reset background after 2 seconds
      Utilities.sleep(2000);
      range.setBackground(originalBackground);
    }
  } catch (error) {
    console.error('Error handling remote selection:', error);
  }
}

function handleConnectionChange(connection) {
  if (!connection?.cellId) return;

  try {
    const sheet = SpreadsheetApp.getActiveSheet();
    const range = sheet.getRange(connection.cellId);
    range.setNote(`Connected to Slide Element: ${connection.slideElementId}`);
    
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
function createConnection(cellId, slideElementId) {
  try {
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

// Event Handlers
function onEdit(e) {
  if (!e) return;

  // Handle cell movement
  if (e.changeType === 'MOVE') {
    onCellMove(e);
    return;
  }

  // Handle value changes
  if (!globalState.autoUpdate) return;

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

function handleConnectionCreate(cellId, slideElementId) {
  const sheet = SpreadsheetApp.getActiveSheet();
  const range = sheet.getRange(cellId);
  
  // Lock the cell to prevent accidental edits
  protectCell(cellId);
  
  return createConnection(cellId, slideElementId);
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
