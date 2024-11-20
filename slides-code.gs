// Global Constants
const BACKEND_URL = 'https://zany-meme-4x75j674p7wfj574-3000.app.github.dev';
const MIN_POLL_INTERVAL = 5000; // 5 seconds minimum
const MAX_POLL_INTERVAL = 30000; // 30 seconds maximum
const BACKOFF_MULTIPLIER = 1.5; // Increase interval by 50% when no updates

// Global state
let globalState = {
  document: null,
  selectedElement: null,
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
  SlidesApp.getUi()
    .createMenu('Hive Theory')
    .addItem('Show Sidebar', 'showSidebar')
    .addToUi();
}

function showSidebar() {
  const html = HtmlService.createHtmlOutputFromFile('slides-sidebar')
    .setTitle('Hive Theory')
    .setWidth(300);
  SlidesApp.getUi().showSidebar(html);
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
    const response = makeRequest('register', 'POST', { type: 'slides' });
    if (response.success) {
      globalState = {
        ...globalState,
        connections: response.initialState.connections,
        lastUpdateTimestamp: Date.now()
      };

      // Only start polling if we have active connections
      if (response.initialState.connections.length > 0) {
        startPolling();
        // Update visual indicators for connected elements
        updateConnectedElements();
      }
      return { success: true, connections: response.initialState.connections };
    }
    return { success: false };
  } catch (error) {
    console.error('Failed to initialize state:', error);
    return { success: false };
  }
}

// Selection Tracking
function onSelectionChange(e) {
  if (!e || !globalState.autoUpdate) return;

  try {
    const selection = SlidesApp.getActivePresentation().getSelection();
    const selectedElements = selection.getPageElementRange()?.getPageElements();
    
    if (!selectedElements || selectedElements.length === 0) {
      globalState.selectedElement = null;
      return;
    }
    
    const element = selectedElements[0];
    const elementInfo = {
      elementId: element.getObjectId(),
      elementType: element.getPageElementType().toString(),
      slideName: element.getParentPage().getObjectId(),
      slideId: element.getParentPage().getObjectId(),
      properties: getElementProperties(element)
    };

    globalState.selectedElement = elementInfo;

    // Broadcast element selection
    makeRequest('selection/slides/broadcast', 'POST', {
      element: elementInfo
    });

    return elementInfo;
  } catch (error) {
    console.error('Error in onSelectionChange:', error);
    return null;
  }
}

// Helper function to get element properties
function getElementProperties(element) {
  try {
    const properties = {
      type: element.getPageElementType().toString(),
      position: {
        left: element.getLeft(),
        top: element.getTop()
      },
      size: {
        width: element.getWidth(),
        height: element.getHeight()
      }
    };

    // Add text content for text-based elements
    if (element.getPageElementType() === SlidesApp.PageElementType.SHAPE ||
        element.getPageElementType() === SlidesApp.PageElementType.TEXT_BOX) {
      properties.text = element.asShape().getText().asString();
    }

    return properties;
  } catch (error) {
    console.error('Error getting element properties:', error);
    return {};
  }
}

// Update Connected Elements
function updateConnectedElements() {
  try {
    const presentation = SlidesApp.getActivePresentation();
    globalState.connections.forEach(connection => {
      const element = findElementById(presentation, connection.slideElementId);
      if (element) {
        updateElementVisualIndicator(element);
      }
    });
  } catch (error) {
    console.error('Error updating connected elements:', error);
  }
}

function updateElementVisualIndicator(element) {
  try {
    if (element.getPageElementType() === SlidesApp.PageElementType.SHAPE ||
        element.getPageElementType() === SlidesApp.PageElementType.TEXT_BOX) {
      const shape = element.asShape();
      const text = shape.getText().asString();
      if (!text.startsWith('📊')) {
        shape.getText().setText(`📊 ${text}`);
      }
    }
  } catch (error) {
    console.error('Error updating element indicator:', error);
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
      `updates/slides?lastUpdate=${globalState.lastUpdateTimestamp}`
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
      case 'value':
        handleValueUpdate(update.content);
        break;
    }
  } catch (error) {
    console.error('Error handling update:', error);
  }
}

function handleRemoteSelection(data) {
  if (!data?.range) return; // Check for range since we're receiving sheet selections

  try {
    // Store remote selection for UI
    globalState.remoteSelection = data;

    // Handle sheet selection - highlight related elements
    const presentation = SlidesApp.getActivePresentation();
    const connection = globalState.connections.find(c => c.cellId === data.range);
    
    if (connection) {
      const element = findElementById(presentation, connection.slideElementId);
      if (element) {
        // Highlight the connected element temporarily
        const originalBorder = element.getBorder();
        element.setBorder(SlidesApp.createSolidBorder('#3b82f6', 2));
        
        // Reset border after 2 seconds
        Utilities.sleep(2000);
        element.setBorder(originalBorder);
      }
    }
  } catch (error) {
    console.error('Error handling remote selection:', error);
  }
}

function handleValueUpdate(content) {
  const { slideElementId, value } = content;
  if (!slideElementId || value === undefined) return false;

  try {
    const presentation = SlidesApp.getActivePresentation();
    const element = findElementById(presentation, slideElementId);
    if (!element) return false;

    switch (element.getPageElementType()) {
      case SlidesApp.PageElementType.SHAPE:
      case SlidesApp.PageElementType.TEXT_BOX:
        const shape = element.asShape();
        const currentText = shape.getText().asString();
        // Preserve the 📊 indicator if it exists
        const prefix = currentText.startsWith('📊') ? '📊 ' : '';
        shape.getText().setText(`${prefix}${value.toString()}`);
        break;
    }
    return true;
  } catch (error) {
    console.error('Error handling value update:', error);
    return false;
  }
}

function findElementById(presentation, id) {
  try {
    for (const slide of presentation.getSlides()) {
      const element = slide.getPageElementById(id);
      if (element) return element;
    }
    return null;
  } catch (error) {
    console.error('Error finding element by ID:', error);
    return null;
  }
}

// Connection Management
function createConnection(slideElement, sheetRange) {
  try {
    const response = makeRequest('connections', 'POST', {
      slideElementId: slideElement.elementId,
      cellId: sheetRange
    });
    
    if (response.success) {
      const hadNoConnections = globalState.connections.length === 0;
      globalState.connections.push(response.connection);
      
      // Update visual indicator
      const presentation = SlidesApp.getActivePresentation();
      const element = findElementById(presentation, slideElement.elementId);
      if (element) {
        updateElementVisualIndicator(element);
      }
      
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

function updateLinkedItem(itemId) {
  try {
    const response = makeRequest(`connections/${itemId}`, 'PUT', {
      lastSyncTime: new Date()
    });
    return response;
  } catch (error) {
    console.error('Error updating linked item:', error);
    return { success: false, error: error.message };
  }
}

function deleteLinkedItem(itemId) {
  try {
    const response = makeRequest(`connections/${itemId}`, 'PUT', {
      active: false
    });
    return response.success;
  } catch (error) {
    console.error('Error deleting linked item:', error);
    return false;
  }
}

function handleConnectionChange(connection) {
  if (!connection?.slideElementId) return;

  try {
    const presentation = SlidesApp.getActivePresentation();
    const element = findElementById(presentation, connection.slideElementId);
    
    if (element) {
      updateElementVisualIndicator(element);
    }
    
    // Update connections and manage polling
    const hadNoConnections = globalState.connections.length === 0;
    globalState.connections = globalState.connections.filter(
      c => c.slideElementId !== connection.slideElementId
    ).concat([connection]);
    
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
