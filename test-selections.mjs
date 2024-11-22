// Mock selection data
const mockSelections = {
    sheets: {
        selection: {
            spreadsheetId: 'mock-spreadsheet-id',
            sheetName: 'Sheet1',
            range: 'A1:B2',
            numRows: 2,
            numColumns: 2
        }
    },
    slides: {
        element: {
            elementId: 'mock-element-id',
            elementType: 'SHAPE',
            slideName: 'mock-slide-id',
            slideId: 'mock-slide-id',
            properties: {
                type: 'SHAPE',
                position: { left: 100, top: 100 },
                size: { width: 200, height: 100 },
                text: 'Mock Text'
            }
        }
    }
};

// Test continuous selection broadcasting
async function simulateSelectionChanges() {
    // Use port 3001 for testing
    const TEST_URL = 'http://localhost:3001';
    
    // Register both apps first
    console.log('Registering apps...');
    
    const registerApps = await Promise.all([
        fetch(`${TEST_URL}/api/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'sheets' })
        }),
        fetch(`${TEST_URL}/api/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'slides' })
        })
    ]);

    console.log('Apps registered:', registerApps.every(r => r.ok));

    // Simulate continuous selection changes
    console.log('\nStarting selection simulation...');
    
    for (let i = 0; i < 5; i++) {
        console.log(`\nIteration ${i + 1}:`);

        // Simulate sheets selection
        console.log('Broadcasting sheets selection...');
        const sheetsResponse = await fetch(`${TEST_URL}/api/selection/sheets/broadcast`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(mockSelections.sheets)
        });
        const sheetsResult = await sheetsResponse.json();
        console.log('Sheets broadcast result:', sheetsResult);

        await new Promise(resolve => setTimeout(resolve, 1000));

        // Simulate slides selection
        console.log('Broadcasting slides selection...');
        const slidesResponse = await fetch(`${TEST_URL}/api/selection/slides/broadcast`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(mockSelections.slides)
        });
        const slidesResult = await slidesResponse.json();
        console.log('Slides broadcast result:', slidesResult);

        await new Promise(resolve => setTimeout(resolve, 1000));

        // Check for updates after each broadcast
        const sheetsUpdates = await fetch(`${TEST_URL}/api/updates/sheets?lastUpdate=${Date.now() - 5000}`);
        const slidesUpdates = await fetch(`${TEST_URL}/api/updates/slides?lastUpdate=${Date.now() - 5000}`);
        
        console.log('\nPending Updates:');
        console.log('Sheets:', await sheetsUpdates.json());
        console.log('Slides:', await slidesUpdates.json());
    }
}

// Run the test
console.log('Starting selection tracking test on port 3001...');
simulateSelectionChanges().catch(console.error);
