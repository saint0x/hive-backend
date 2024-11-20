import fetch from 'node-fetch';

const BASE_URL = 'http://localhost:3000/api';
let lastUpdateTimestamp = Date.now();

// Test data
const mockSheetSelection = {
  spreadsheetId: "test-sheet-id",
  sheetName: "Sheet1",
  range: "A1",
  numRows: 1,
  numColumns: 1
};

const mockSlideElement = {
  elementId: "test-element-id",
  elementType: "SHAPE",
  slideName: "slide1",
  slideId: "slide1",
  properties: {
    type: "SHAPE",
    position: { left: 100, top: 100 },
    size: { width: 200, height: 100 }
  }
};

// Utility function for making requests
async function makeRequest(endpoint, method = 'GET', body = null) {
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
    }
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(`${BASE_URL}/${endpoint}`, options);
    const data = await response.json();
    console.log(`Response from ${endpoint}:`, data);
    return { success: response.ok, data };
  } catch (error) {
    console.error(`Error making request to ${endpoint}:`, error);
    return { success: false, error };
  }
}

// Test functions
async function cleanupDatabase() {
  console.log('\n🧹 Cleaning up test database');
  const cleanup = await makeRequest('test/cleanup', 'POST');
  console.log('Database cleanup:', cleanup.success ? '✅' : '❌');
  return cleanup.success;
}

async function testRegisterApps() {
  console.log('\n🔄 Testing App Registration');
  
  const sheetsResult = await makeRequest('register', 'POST', { type: 'sheets' });
  console.log('Sheets Registration:', sheetsResult.success ? '✅' : '❌');
  
  const slidesResult = await makeRequest('register', 'POST', { type: 'slides' });
  console.log('Slides Registration:', slidesResult.success ? '✅' : '❌');
  
  return sheetsResult.success && slidesResult.success;
}

async function testSelectionBroadcast() {
  console.log('\n🔄 Testing Selection Broadcasting');
  
  // Broadcast sheet selection
  const sheetBroadcast = await makeRequest('selection/sheets/broadcast', 'POST', {
    selection: mockSheetSelection
  });
  console.log('Sheet Selection Broadcast:', sheetBroadcast.success ? '✅' : '❌');
  
  // Broadcast slide selection
  const slideBroadcast = await makeRequest('selection/slides/broadcast', 'POST', {
    element: mockSlideElement
  });
  console.log('Slide Selection Broadcast:', slideBroadcast.success ? '✅' : '❌');
  
  return sheetBroadcast.success && slideBroadcast.success;
}

async function testCreateConnection() {
  console.log('\n🔄 Testing Connection Creation');
  
  // Create connection directly with IDs
  const connection = await makeRequest('connections', 'POST', {
    cellId: `${mockSheetSelection.sheetName}!${mockSheetSelection.range}`,
    slideElementId: mockSlideElement.elementId
  });
  
  console.log('Connection Creation:', connection.success ? '✅' : '❌');
  
  if (connection.success) {
    console.log('Connection ID:', connection.data.connection.id);
    return connection.data.connection;
  }
  return null;
}

async function testValueUpdate(connectionId) {
  console.log('\n🔄 Testing Value Updates');
  
  const update = await makeRequest('updates/cell', 'POST', {
    connectionId,
    value: "Updated Value",
    timestamp: Date.now()
  });
  
  console.log('Value Update:', update.success ? '✅' : '❌');
  return update.success;
}

async function testUpdatePolling() {
  console.log('\n🔄 Testing Update Polling');
  
  // Test sheets updates
  const sheetsUpdates = await makeRequest(
    `updates/sheets?lastUpdate=${lastUpdateTimestamp}`
  );
  console.log('Sheets Updates Polling:', sheetsUpdates.success ? '✅' : '❌');
  
  // Test slides updates
  const slidesUpdates = await makeRequest(
    `updates/slides?lastUpdate=${lastUpdateTimestamp}`
  );
  console.log('Slides Updates Polling:', slidesUpdates.success ? '✅' : '❌');
  
  return sheetsUpdates.success && slidesUpdates.success;
}

async function testConnectionManagement(connectionId) {
  console.log('\n🔄 Testing Connection Management');
  
  // Test updating connection
  const updateResult = await makeRequest(`connections/${connectionId}`, 'PUT', {
    active: true,
    syncEnabled: true
  });
  console.log('Connection Update:', updateResult.success ? '✅' : '❌');
  
  // Test connection health check
  const healthCheck = await makeRequest('connections/health', 'GET');
  console.log('Connection Health Check:', healthCheck.success ? '✅' : '❌');
  
  return updateResult.success && healthCheck.success;
}

async function testAcknowledgeUpdates() {
  console.log('\n🔄 Testing Update Acknowledgment');
  
  const ack = await makeRequest('updates/acknowledge', 'POST', {
    updateIds: ['test-update-id']
  });
  
  console.log('Update Acknowledgment:', ack.success ? '✅' : '❌');
  return ack.success;
}

// Main test flow
async function runTests() {
  console.log('🚀 Starting Integration Tests\n');
  
  try {
    // Clean up database first
    const cleaned = await cleanupDatabase();
    if (!cleaned) throw new Error('Database cleanup failed');

    // Step 1: Register apps
    const registered = await testRegisterApps();
    if (!registered) throw new Error('Registration failed');
    
    // Step 2: Test selection broadcasting
    const selectionsBroadcast = await testSelectionBroadcast();
    if (!selectionsBroadcast) throw new Error('Selection broadcasting failed');
    
    // Step 3: Create connection
    const connection = await testCreateConnection();
    if (!connection) throw new Error('Connection creation failed');
    
    // Step 4: Test value updates
    const valueUpdated = await testValueUpdate(connection.id);
    if (!valueUpdated) throw new Error('Value update failed');
    
    // Step 5: Test update polling
    const pollingWorks = await testUpdatePolling();
    if (!pollingWorks) throw new Error('Update polling failed');
    
    // Step 6: Test connection management
    const connectionManaged = await testConnectionManagement(connection.id);
    if (!connectionManaged) throw new Error('Connection management failed');
    
    // Step 7: Test update acknowledgment
    const updatesAcknowledged = await testAcknowledgeUpdates();
    if (!updatesAcknowledged) throw new Error('Update acknowledgment failed');
    
    console.log('\n✨ All tests completed successfully!');
  } catch (error) {
    console.error('\n❌ Test suite failed:', error.message);
  }
}

// Run the tests
runTests();
