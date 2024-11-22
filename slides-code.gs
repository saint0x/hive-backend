// Global Constants (same as sheets)
const BACKEND_URL = 'https://zany-meme-4x75j674p7wfj574-3000.app.github.dev';
const MIN_POLL_INTERVAL = 1000;
const MAX_POLL_INTERVAL = 30000;
const BACKOFF_MULTIPLIER = 1.5;
const MAX_RETRIES = 3;

// Enhanced Global State (parallel to sheets but with slides-specific fields)
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
  lastCursorPosition: null,
  selectionRetryCount: 0,
  maxRetries: 3,
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
  connectionStatus: 'disconnected'
};

// Enhanced initialization handling
function handleInitSuccess(response) {
    try {
        // Ensure response is properly parsed if it's a string
        const data = typeof response === 'string' ? JSON.parse(response) : response;
        
        // Validate the response structure
        if (!data || typeof data !== 'object') {
            throw new Error('Invalid initialization response');
        }

        // Update state with defaults if properties are missing
        globalState = {
            ...globalState,
            initialized: true,
            connections: data.connections || [],
            connectionStatus: 'connected',
            lastSyncTime: Date.now(),
            // Preserve any existing state properties
            ...data.state || {}
        };

        updateLinkedItems();
        updateSyncStatus();
        showToast('Successfully connected to server', 'success');
    } catch (error) {
        console.error('Initialization error:', error);
        handleInitError(error);
    }
}

// UI Setup (same structure as sheets)
function onOpen(e) {
  SlidesApp.getUi()
    .createMenu('Hive Theory')
    .addItem('Show Sidebar', 'showSidebar')
    .addToUi();
}

function showSidebar() {
  const html = HtmlService.createHtmlOutputFromFile('sidebar')
    .setTitle('Hive Theory')
    .setWidth(300);
  SlidesApp.getUi().showSidebar(html);
}

// Enhanced API Communication (identical to sheets)
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

// Connection Management (parallel to sheets but for slides)
function createConnection(slideElementId, cellId) {
  try {
    if (!validateElement(slideElementId)) {
      throw new Error('Invalid element selection');
    }

    const payload = {
      slideElementId,
      cellId,
      timestamp: Date.now()
    };

    const response = makeRequest('connections', 'POST', payload);
    if (response.success) {
      const connection = response.connection;
      globalState.connections.push(connection);
      updateElementVisualIndicator(findElementById(
        SlidesApp.getActivePresentation(),
        connection.slideElementId
      ));
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
      const element = findElementById(
        SlidesApp.getActivePresentation(),
        connection.slideElementId
      );
      if (element) {
        removeElementVisualIndicator(element);
      }
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

function validateElement(elementId) {
  try {
    const presentation = SlidesApp.getActivePresentation();
    const element = findElementById(presentation, elementId);
    return element !== null;
  } catch (error) {
    console.error('Element validation failed:', error);
    return false;
  }
}

function removeElementVisualIndicator(element) {
  try {
    if (element.getPageElementType() === SlidesApp.PageElementType.SHAPE ||
        element.getPageElementType() === SlidesApp.PageElementType.TEXT_BOX) {
      const shape = element.asShape();
      const currentText = shape.getText().asString();
      if (currentText.startsWith('📊')) {
        shape.getText().setText(currentText.substring(2));
      }
      shape.getBorder()
        .setWeight(1)
        .setSolidFill('#000000');
    }
  } catch (error) {
    console.error('Error removing element indicator:', error);
  }
}

function showUserFeedback(message, type = 'info') {
  try {
    const ui = SlidesApp.getUi();
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

// Enhanced Error Recovery
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

function handleTableCellSelection(selection) {
  try {
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
  } catch (error) {
    console.error('Error handling table cell selection:', error);
    return null;
  }
}

function handleCurrentPageSelection(selection) {
  try {
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
  } catch (error) {
    console.error('Error handling current page selection:', error);
    return null;
  }
}

function getTextStyleProperties(textStyle) {
  try {
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
  } catch (error) {
    console.error('Error getting text style properties:', error);
    return {};
  }
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
  if (!data?.range) return;

  try {
    globalState.remoteSelection = {
      ...data,
      receivedAt: Date.now()
    };

    const connection = globalState.connections.find(c => c.cellId === data.range);
    if (connection) {
      const presentation = SlidesApp.getActivePresentation();
      const element = findElementById(presentation, connection.slideElementId);
      if (element) {
        const shape = element.asShape();
        const originalBorder = {
          weight: shape.getBorder().getWeight(),
          color: shape.getBorder().getSolidFill()?.getColor()?.asRgbColor()?.asHexString() || '#000000'
        };

        shape.getBorder()
          .setWeight(3)
          .setSolidFill('#ff4081');
        
        Utilities.sleep(2000);
        shape.getBorder()
          .setWeight(originalBorder.weight)
          .setSolidFill(originalBorder.color);

        if (globalState.selectedElement) {
          makeRequest('selection/slides/broadcast', 'POST', {
            element: globalState.selectedElement,
            timestamp: Date.now(),
            cursorPosition: globalState.lastCursorPosition
          });
        }
      }
    }

    globalState.lastSyncTime = Date.now();
  } catch (error) {
    console.error('Error handling remote selection:', error);
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
    
    globalState.connections = globalState.connections.filter(
      c => c.slideElementId !== connection.slideElementId
    ).concat([connection]);
    
    globalState.lastSyncTime = Date.now();
  } catch (error) {
    console.error('Error handling connection change:', error);
  }
}

function updateElementVisualIndicator(element) {
  try {
    if (element.getPageElementType() === SlidesApp.PageElementType.SHAPE ||
        element.getPageElementType() === SlidesApp.PageElementType.TEXT_BOX) {
      const shape = element.asShape();
      const currentText = shape.getText().asString();
      if (!currentText.startsWith('📊')) {
        shape.getText().setText(`📊 ${currentText}`);
      }
      
      shape.getBorder()
        .setWeight(2)
        .setSolidFill('#3b82f6');
    }
  } catch (error) {
    console.error('Error updating element indicator:', error);
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
      globalState.lastSyncTime = Date.now();
    }
  } catch (error) {
    console.error('Error handling value update:', error);
  }
}

function findElementById(presentation, elementId) {
  try {
    const slides = presentation.getSlides();
    for (let i = 0; i < slides.length; i++) {
      const elements = slides[i].getPageElements();
      for (let j = 0; j < elements.length; j++) {
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

// Add cleanup function
function cleanup() {
  try {
    stopPolling();
    globalState.connections.forEach(connection => {
      const element = findElementById(
        SlidesApp.getActivePresentation(),
        connection.slideElementId
      );
      if (element) {
        removeElementVisualIndicator(element);
      }
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
