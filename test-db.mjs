import dbManager from './db.mjs';

async function cleanupDatabase() {
    try {
        await dbManager.run('DELETE FROM sync_status');
        await dbManager.run('DELETE FROM updates');
        await dbManager.run('DELETE FROM error_logs');
        await dbManager.run('DELETE FROM app_states');
        await dbManager.run('DELETE FROM connections');
        console.log('🧹 Database cleaned');
    } catch (error) {
        console.error('Failed to cleanup database:', error);
    }
}

async function runTests() {
    let backupPath = null;
    
    console.log('Starting comprehensive app integration tests...');
    
    try {
        await dbManager.initialize();
        console.log('✅ Database initialized');
        await cleanupDatabase();

        // Test 1: Sheets App Registration
        const sheetsApp = {
            id: `app-sheets-${Date.now()}`,
            appType: 'sheets',
            status: 'active',
            connectionCount: 0
        };
        await dbManager.updateAppState(sheetsApp);
        console.log('✅ Sheets app registered');

        // Test 2: Slides App Registration
        const slidesApp = {
            id: `app-slides-${Date.now()}`,
            appType: 'slides',
            status: 'active',
            connectionCount: 0
        };
        await dbManager.updateAppState(slidesApp);
        console.log('✅ Slides app registered');

        // Test 3: Create Connection between Sheet and Slide
        const connection = {
            id: `conn-${Date.now()}`,
            cellId: 'Sheet1!A1',
            slideElementId: 'slide-123',
            originalCellId: 'Sheet1!A1'
        };
        await dbManager.insertConnection(connection);
        console.log('✅ Connection created');

        // Test 4: Selection Updates
        const sheetsSelection = {
            id: `upd-${Date.now()}-1`,
            type: 'selection',
            sourceType: 'sheets',
            targetType: 'slides',
            content: {
                range: 'Sheet1!A1',
                sheetName: 'Sheet1',
                timestamp: Date.now()
            }
        };
        await dbManager.insertUpdate(sheetsSelection);
        console.log('✅ Sheets selection update created');

        const slidesSelection = {
            id: `upd-${Date.now()}-2`,
            type: 'selection',
            sourceType: 'slides',
            targetType: 'sheets',
            content: {
                elementId: 'slide-123',
                elementType: 'SHAPE',
                timestamp: Date.now()
            }
        };
        await dbManager.insertUpdate(slidesSelection);
        console.log('✅ Slides selection update created');

        // Test 5: Value Sync
        const valueUpdate = {
            id: `upd-${Date.now()}-3`,
            type: 'value',
            sourceType: 'sheets',
            targetType: 'slides',
            content: {
                value: 'test value',
                connectionId: connection.id
            },
            priority: 1
        };
        await dbManager.insertUpdate(valueUpdate);
        console.log('✅ Value update created');

        // Test 6: Connection Status Updates
        await dbManager.updateConnectionStatus(connection.id, 'active');
        await dbManager.updateSyncStatus(connection.id, 'synced');
        console.log('✅ Connection status updates working');

        // Test 7: Error Handling
        const sheetsError = new Error('Sheets sync failed');
        sheetsError.metadata = { cellId: 'Sheet1!A1' };
        await dbManager.logError(sheetsError, 'sheets');

        const slidesError = new Error('Slides element not found');
        slidesError.metadata = { elementId: 'slide-123' };
        await dbManager.logError(slidesError, 'slides');
        console.log('✅ Error logging working');

        // Test 8: Update Processing
        const updates = await dbManager.getPendingUpdates('slides', 10);
        await dbManager.markUpdatesProcessed(updates.map(u => u.id));
        console.log('✅ Update processing working');

        // Test 9: Health Check
        const health = await dbManager.monitorHealth();
        console.log('✅ Health monitoring working:', health);

        // Test 10: Stale Data Cleanup
        await dbManager.cleanupStaleData(0);
        console.log('✅ Stale data cleanup working');

        // Test 11: App State Updates
        await dbManager.updateAppLastSeen(sheetsApp.id);
        await dbManager.updateAppLastSeen(slidesApp.id);
        console.log('✅ App state updates working');

        // Test 12: Connection Queries
        const activeConns = await dbManager.getActiveConnections();
        console.log('✅ Active connections:', activeConns.length);

        // Test 13: Unacknowledged Updates
        const unacknowledged = await dbManager.getUnacknowledgedUpdates('slides');
        console.log('✅ Unacknowledged updates:', unacknowledged.length);

        // Test 14: Migration Version
        const version = await dbManager.getMigrationVersion();
        console.log('✅ Database version:', version);

        // Test 15: Backup
        backupPath = await dbManager.backup();
        console.log('✅ Backup created:', backupPath);

        console.log('\n✨ All app integration tests passed successfully!');
        
        // Print final state
        console.log('\n📊 Final Database State:');
        console.log('Connections:', activeConns.length);
        console.log('Pending Updates:', updates.length);
        console.log('Error Logs:', (await dbManager.getRecentErrors('sheets')).length);
        console.log('App States:', (await dbManager.all('SELECT * FROM app_states')).length);

    } catch (error) {
        console.error('❌ Tests failed:', error);
        throw error;
    } finally {
        try {
            // Clean up database first
            await cleanupDatabase();
            
            // Wait for any pending operations
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // Close the database
            await dbManager.close();
            console.log('\nDatabase connection closed');
            
            // Clean up backup file if it exists
            if (backupPath) {
                const fs = await import('fs');
                try {
                    await fs.promises.unlink(backupPath);
                    console.log('Backup file cleaned up');
                } catch (err) {
                    console.error('Failed to clean up backup file:', err);
                }
            }
        } catch (error) {
            console.error('Error during cleanup:', error);
        }
    }
}

runTests().catch(error => {
    console.error('Test suite failed:', error);
    process.exit(1);
});