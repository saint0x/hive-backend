// Global Constants
const BACKEND_URL = 'https://zany-meme-4x75j674p7wfj574-3000.app.github.dev';
const MIN_POLL_INTERVAL = 1000; // Match server's MIN_UPDATE_INTERVAL_MS
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
  lastUpdateReceived: Date.now(),
  lastSelectionType: null,
  lastCursorPosition: null, // Added for cursor tracking
  selectionRetryCount: 0,   // Added for error recovery
  maxRetries: 3,           // Added for error recovery
  lastSyncTime: Date.now() // Track last sync time
};

// UI Setup
function onOpen(e) {
  SlidesApp.getUi()
    .createMenu('Hive Theory')
    .addItem('Show Sidebar', 'showSidebar')
    .addToUi();
  startPolling();
}

function showSidebar() {
  const html = HtmlService.createHtmlOutputFromFile('sidebar')
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

      // Start selection tracking immediately
      startSelectionTracking();

      // Only start polling if we have active connections
      if (response.initialState.connections.length > 0) {
        startPolling();
        // Update visual indicators for connected elements
        updateConnectedElements();
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

// Enhanced Selection Tracking
function startSelectionTracking() {
  // Run initial selection check
  onSelectionChange();
  
  // Set up continuous selection tracking
  const presentation = SlidesApp.getActivePresentation();
  const triggers = ScriptApp.getUserTriggers(presentation);
  
  // Remove any existing selection triggers to avoid duplicates
  triggers.forEach(trigger => {
    if (trigger.getEventType() === ScriptApp.EventType.ON_SELECTION_CHANGE) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  
  // Create new selection trigger with immediate execution
  ScriptApp.newTrigger('onSelectionChange')
    .forPresentation(presentation)
    .onSelectionChange()
    .create();
}

function validateSelection(selection) {
  if (!selection) return false;
  try {
    const selectionType = selection.getSelectionType();
    return selectionType !== null && selectionType !== undefined;
  } catch (error) {
    console.error('Selection validation failed:', error);
    return false;
  }
}

function onSelectionChange(e) {
  try {
    const selection = SlidesApp.getActivePresentation().getSelection();
    if (!validateSelection(selection)) {
      if (globalState.selectionRetryCount < globalState.maxRetries) {
        globalState.selectionRetryCount++;
        // Retry after a short delay
        Utilities.sleep(100);
        return onSelectionChange(e);
      }
      globalState.selectionRetryCount = 0;
      return null;
    }
    
    globalState.selectionRetryCount = 0;
    const selectionType = selection.getSelectionType();
    let selectionInfo = null;

    switch (selectionType) {
      case SlidesApp.SelectionType.TEXT:
        selectionInfo = handleTextSelection(selection);
        break;
      case SlidesApp.SelectionType.PAGE_ELEMENT:
        selectionInfo = handlePageElementSelection(selection);
        break;
      case SlidesApp.SelectionType.TABLE_CELL:
        selectionInfo = handleTableCellSelection(selection);
        break;
      case SlidesApp.SelectionType.CURRENT_PAGE:
        selectionInfo = handleCurrentPageSelection(selection);
        break;
      case SlidesApp.SelectionType.NONE:
        // Handle no selection
        selectionInfo = {
          type: 'NONE',
          timestamp: Date.now()
        };
        break;
    }

    if (selectionInfo) {
      // Update local state
      globalState.selectedElement = selectionInfo;
      globalState.lastSelectionType = selectionType;

      // Add retry mechanism for broadcasting
      let broadcastAttempts = 0;
      const maxBroadcastAttempts = 3;
      
      while (broadcastAttempts < maxBroadcastAttempts) {
        try {
          // Broadcast selection immediately
          makeRequest('selection/slides/broadcast', 'POST', {
            element: selectionInfo,
            timestamp: Date.now(),
            cursorPosition: globalState.lastCursorPosition
          });
          break;
        } catch (error) {
          broadcastAttempts++;
          if (broadcastAttempts === maxBroadcastAttempts) {
            console.error('Failed to broadcast selection after multiple attempts:', error);
          } else {
            Utilities.sleep(100 * broadcastAttempts);
          }
        }
      }
    }

    return selectionInfo;
  } catch (error) {
    console.error('Error in onSelectionChange:', error);
    return null;
  }
}

function handleTextSelection(selection) {
  const textRange = selection.getTextRange();
  const textElement = textRange.getTextStyle().getTextRange().getParentElement();
  const parentPage = textElement.getParentPage();
  
  // Track cursor position
  const cursorPosition = {
    startIndex: textRange.getStartIndex(),
    endIndex: textRange.getEndIndex()
  };
  globalState.lastCursorPosition = cursorPosition;
  
  return {
    elementId: textElement.getObjectId(),
    elementType: 'TEXT',
    slideName: parentPage.getObjectId(),
    slideId: parentPage.getObjectId(),
    slideIndex: parentPage.getObjectId(),
    textSelection: {
      startIndex: textRange.getStartIndex(),
      endIndex: textRange.getEndIndex(),
      selectedText: textRange.asString(),
      textStyle: getTextStyleProperties(textRange.getTextStyle()),
      cursorPosition: cursorPosition
    },
    properties: getElementProperties(textElement),
    timestamp: Date.now()
  };
}

function handlePageElementSelection(selection) {
  const elements = selection.getPageElementRange().getPageElements();
  if (!elements || elements.length === 0) return null;
  
  const element = elements[0];
  const parentPage = element.getParentPage();
  
  // Get detailed dimension info
  const dimensionInfo = {
    size: {
      width: {
        magnitude: element.getWidth(),
        unit: 'PT' // Points (1/72 of an inch)
      },
      height: {
        magnitude: element.getHeight(),
        unit: 'PT'
      }
    },
    position: {
      left: {
        magnitude: element.getLeft(),
        unit: 'PT'
      },
      top: {
        magnitude: element.getTop(),
        unit: 'PT'
      }
    }
  };
  
  return {
    elementId: element.getObjectId(),
    elementType: element.getPageElementType().toString(),
    slideName: parentPage.getObjectId(),
    slideId: parentPage.getObjectId(),
    slideIndex: parentPage.getObjectId(),
    properties: getElementProperties(element),
    multipleElements: elements.length > 1,
    totalElements: elements.length,
    dimensions: dimensionInfo,
    timestamp: Date.now()
  };
}

function handleTableCellSelection(selection) {
  const tableRange = selection.getTableRange();
  const table = tableRange.getParentTable();
  const parentPage = table.getParentPage();
  
  return {
    elementId: table.getObjectId(),
    elementType: 'TABLE_CELL',
    slideName: parentPage.getObjectId(),
    slideId: parentPage.getObjectId(),
    slideIndex: parentPage.getObjectId(),
    tableSelection: {
      row: tableRange.getRow(),
      column: tableRange.getColumn(),
      rowSpan: tableRange.getRowSpan(),
      columnSpan: tableRange.getColumnSpan()
    },
    properties: getElementProperties(table),
    timestamp: Date.now()
  };
}

function handleCurrentPageSelection(selection) {
  const currentPage = selection.getCurrentPage();
  
  return {
    elementId: currentPage.getObjectId(),
    elementType: 'PAGE',
    slideName: currentPage.getObjectId(),
    slideId: currentPage.getObjectId(),
    slideIndex: currentPage.getObjectId(),
    properties: {
      pageNumber: currentPage.getObjectId(),
      layout: currentPage.getLayout().getLayoutType().toString()
    },
    timestamp: Date.now()
  };
}

function getTextStyleProperties(textStyle) {
  return {
    bold: textStyle.isBold(),
    italic: textStyle.isItalic(),
    underline: textStyle.isUnderline(),
    strikethrough: textStyle.isStrikethrough(),
    fontSize: textStyle.getFontSize(),
    fontFamily: textStyle.getFontFamily(),
    foregroundColor: textStyle.getForegroundColor()?.asRgbColor()?.asHexString(),
    backgroundColor: textStyle.getBackgroundColor()?.asRgbColor()?.asHexString()
  };
}

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

    switch (element.getPageElementType()) {
      case SlidesApp.PageElementType.SHAPE:
      case SlidesApp.PageElementType.TEXT_BOX:
        const shape = element.asShape();
        properties.text = shape.getText().asString();
        properties.shapeType = shape.getShapeType();
        properties.fill = {
          type: shape.getFill().getType().toString(),
          color: shape.getFill().getSolidFill()?.getColor()?.asRgbColor()?.asHexString()
        };
        properties.border = {
          weight: shape.getBorder().getWeight(),
          dashStyle: shape.getBorder().getDashStyle().toString(),
          color: shape.getBorder().getSolidFill()?.getColor()?.asRgbColor()?.asHexString()
        };
        break;
        
      case SlidesApp.PageElementType.IMAGE:
        const image = element.asImage();
        properties.imageProperties = {
          sourceUrl: image.getSourceUrl(),
          brightness: image.getBrightness(),
          contrast: image.getContrast(),
          transparency: image.getTransparency()
        };
        break;
        
      case SlidesApp.PageElementType.TABLE:
        const table = element.asTable();
        properties.tableProperties = {
          numRows: table.getNumRows(),
          numColumns: table.getNumColumns(),
          hasHeader: table.getRow(0).getMinimumHeight() > table.getRow(1).getMinimumHeight()
        };
        break;
        
      case SlidesApp.PageElementType.GROUP:
        const group = element.asGroup();
        properties.groupProperties = {
          numChildren: group.getChildren().length
        };
        break;
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
      // Get current text and check if it already has the indicator
      const currentText = shape.getText().asString();
      if (!currentText.startsWith('📊')) {
        // Add indicator while preserving existing text
        shape.getText().setText(`📊 ${currentText}`);
      }
      
      // Add a blue border to indicate connection
      shape.getBorder().setWeight(2).setSolidFill('#3b82f6');
    }
  } catch (error) {
    console.error('Error updating element indicator:', error);
  }
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

// Handle Updates
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

function handleValueUpdate(data) {
  if (!data?.slideElementId) return;

  try {
    const presentation = SlidesApp.getActivePresentation();
    const element = findElementById(presentation, data.slideElementId);
    if (element && element.getPageElementType() === SlidesApp.PageElementType.SHAPE) {
      const shape = element.asShape();
      shape.getText().setText(String(data.value));
    }
  } catch (error) {
    console.error('Error handling value update:', error);
  }
}

function handleRemoteSelection(data) {
  if (!data?.elementId) return;

  try {
    // Store remote selection with timestamp
    globalState.remoteSelection = {
      ...data,
      receivedAt: Date.now()
    };

    // Find any connections related to this element
    const connection = globalState.connections.find(c => c.slideElementId === data.elementId);
    if (connection) {
      const presentation = SlidesApp.getActivePresentation();
      const element = findElementById(presentation, data.elementId);
      if (element) {
        // Store original border
        const shape = element.asShape();
        const originalBorder = {
          weight: shape.getBorder().getWeight(),
          color: shape.getBorder().getSolidFill()?.getColor()?.asRgbColor()?.asHexString() || '#000000'
        };

        // Pink highlight for visibility
        shape.getBorder()
          .setWeight(3)
          .setSolidFill('#ff4081');
        
        // Reset border after 2 seconds
        Utilities.sleep(2000);
        shape.getBorder()
          .setWeight(originalBorder.weight)
          .setSolidFill(originalBorder.color);

        // Broadcast our current selection in response
        if (globalState.selectedElement) {
          makeRequest('selection/slides/broadcast', 'POST', {
            element: globalState.selectedElement,
            timestamp: Date.now(),
            cursorPosition: globalState.lastCursorPosition
          });
        }
      }
    }
  } catch (error) {
    console.error('Error handling remote selection:', error);
  }
}

function findElementById(presentation, elementId) {
  try {
    var slides = presentation.getSlides();
    for (var i = 0; i < slides.length; i++) {
      var elements = slides[i].getPageElements();
      for (var j = 0; j < elements.length; j++) {
        if (elements[j].getObjectId() === elementId) {
          return elements[j];
        }
      }
    }
    return null;
  } catch (error) {
    console.error('Error finding element by ID:', error);
    return null;
  }
}
