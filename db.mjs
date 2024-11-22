import sqlite3 from 'sqlite3';
import { promisify } from 'util';

// Database Configuration
const DB_CONFIG = {
    filename: 'hive.db',
    mode: sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
    pragmas: [
        'PRAGMA journal_mode = WAL',
        'PRAGMA synchronous = NORMAL',
        'PRAGMA foreign_keys = ON',
        'PRAGMA temp_store = MEMORY'
    ]
};

// Schema Definitions
const SCHEMA = {
    connections: `
        CREATE TABLE IF NOT EXISTS connections (
            id TEXT PRIMARY KEY,
            cell_id TEXT,
            slide_element_id TEXT,
            original_cell_id TEXT,
            active BOOLEAN DEFAULT 1,
            sync_enabled BOOLEAN DEFAULT 1,
            last_sync_time DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_error TEXT,
            retry_count INTEGER DEFAULT 0,
            status TEXT DEFAULT 'active',
            metadata TEXT,
            UNIQUE(original_cell_id, slide_element_id)
        )
    `,
    updates: `
        CREATE TABLE IF NOT EXISTS updates (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            source_type TEXT NOT NULL,
            target_type TEXT NOT NULL,
            content TEXT NOT NULL,
            processed BOOLEAN DEFAULT 0,
            acknowledged BOOLEAN DEFAULT 0,
            processed_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            error_count INTEGER DEFAULT 0,
            last_error TEXT,
            priority INTEGER DEFAULT 0,
            UNIQUE(id)
        )
    `,
    app_states: `
        CREATE TABLE IF NOT EXISTS app_states (
            id TEXT PRIMARY KEY,
            app_type TEXT NOT NULL,
            last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
            status TEXT DEFAULT 'active',
            connection_count INTEGER DEFAULT 0,
            last_error TEXT,
            metadata TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `,
    error_logs: `
        CREATE TABLE IF NOT EXISTS error_logs (
            id TEXT PRIMARY KEY,
            app_type TEXT NOT NULL,
            error_type TEXT NOT NULL,
            message TEXT NOT NULL,
            stack_trace TEXT,
            metadata TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `,
    sync_status: `
        CREATE TABLE IF NOT EXISTS sync_status (
            id TEXT PRIMARY KEY,
            connection_id TEXT NOT NULL,
            last_sync_time DATETIME DEFAULT CURRENT_TIMESTAMP,
            status TEXT DEFAULT 'synced',
            retry_count INTEGER DEFAULT 0,
            last_error TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(connection_id) REFERENCES connections(id)
        )
    `
};

// Index Definitions
const INDEXES = [
    'CREATE INDEX IF NOT EXISTS idx_connections_active ON connections(active)',
    'CREATE INDEX IF NOT EXISTS idx_updates_processed ON updates(processed)',
    'CREATE INDEX IF NOT EXISTS idx_updates_type ON updates(type)',
    'CREATE INDEX IF NOT EXISTS idx_app_states_status ON app_states(status)',
    'CREATE INDEX IF NOT EXISTS idx_sync_status_connection ON sync_status(connection_id)'
];

// Trigger Definitions
const TRIGGERS = [
    `
    CREATE TRIGGER IF NOT EXISTS update_app_states_timestamp 
    AFTER UPDATE ON app_states
    BEGIN
        UPDATE app_states SET updated_at = CURRENT_TIMESTAMP 
        WHERE id = NEW.id;
    END;
    `,
    `
    CREATE TRIGGER IF NOT EXISTS update_sync_status_timestamp 
    AFTER UPDATE ON sync_status
    BEGIN
        UPDATE sync_status SET updated_at = CURRENT_TIMESTAMP 
        WHERE id = NEW.id;
    END;
    `
];

// Add Migration System
const MIGRATIONS = [
    {
        version: 1,
        up: async (db) => {
            // Initial schema - already handled by SCHEMA definitions
            return true;
        }
    },
    {
        version: 2,
        up: async (db) => {
            // Add priority column if it doesn't exist
            try {
                // Check if column exists first
                await db.get('SELECT priority FROM updates LIMIT 1');
            } catch (error) {
                if (error.code === 'SQLITE_ERROR') {
                    // Column doesn't exist, add it
                    await db.run('ALTER TABLE updates ADD COLUMN priority INTEGER DEFAULT 0');
                }
            }
            return true;
        }
    },
    {
        version: 3,
        up: async (db) => {
            // Add metadata columns if they don't exist
            try {
                await db.get('SELECT metadata FROM connections LIMIT 1');
            } catch (error) {
                if (error.code === 'SQLITE_ERROR') {
                    await db.run('ALTER TABLE connections ADD COLUMN metadata TEXT');
                }
            }

            try {
                await db.get('SELECT metadata FROM app_states LIMIT 1');
            } catch (error) {
                if (error.code === 'SQLITE_ERROR') {
                    await db.run('ALTER TABLE app_states ADD COLUMN metadata TEXT');
                }
            }
            return true;
        }
    }
];

class DatabaseManager {
    constructor() {
        this.db = null;
        this.initialized = false;
    }

    async initialize() {
        try {
            this.db = new sqlite3.Database(DB_CONFIG.filename, DB_CONFIG.mode);
            
            // Promisify database methods
            this.run = promisify(this.db.run.bind(this.db));
            this.all = promisify(this.db.all.bind(this.db));
            this.get = promisify(this.db.get.bind(this.db));
            
            // Set pragmas
            for (const pragma of DB_CONFIG.pragmas) {
                await this.run(pragma);
            }

            // Run migrations before creating schema
            await this.runMigrations();

            // Create tables (these now act as initial schema)
            for (const [table, schema] of Object.entries(SCHEMA)) {
                await this.run(schema);
            }

            // Create indexes
            for (const index of INDEXES) {
                await this.run(index);
            }

            // Create triggers
            for (const trigger of TRIGGERS) {
                await this.run(trigger);
            }

            this.initialized = true;
            console.log('Database initialized successfully');
            
        } catch (error) {
            console.error('Database initialization failed:', error);
            throw error;
        }
    }

    async close() {
        if (this.db) {
            try {
                // Finalize all statements
                await this.run('PRAGMA optimize');
                
                // Wait for any pending operations
                await new Promise(resolve => setTimeout(resolve, 100));
                
                // Close the database
                await new Promise((resolve, reject) => {
                    this.db.close((err) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve();
                        }
                    });
                });
            } catch (error) {
                console.error('Error closing database:', error);
                throw error;
            }
        }
    }

    // Utility methods for common operations
    async insertConnection(connection) {
        const { id, cellId, slideElementId, originalCellId } = connection;
        return this.run(
            `INSERT INTO connections (id, cell_id, slide_element_id, original_cell_id)
             VALUES (?, ?, ?, ?)`,
            [id, cellId, slideElementId, originalCellId]
        );
    }

    async insertUpdate(update) {
        const { id, type, sourceType, targetType, content, priority = 0 } = update;
        return this.run(
            `INSERT INTO updates (id, type, source_type, target_type, content, priority)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [id, type, sourceType, targetType, JSON.stringify(content), priority]
        );
    }

    async logError(error, appType) {
        const id = `err-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        return this.run(
            `INSERT INTO error_logs (id, app_type, error_type, message, stack_trace, metadata)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [id, appType, error.name, error.message, error.stack, JSON.stringify(error.metadata || {})]
        );
    }

    async updateAppState(appState) {
        const { id, appType, status, connectionCount, metadata } = appState;
        return this.run(
            `INSERT OR REPLACE INTO app_states 
             (id, app_type, status, connection_count, metadata, last_seen)
             VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            [id, appType, status, connectionCount, JSON.stringify(metadata || {})]
        );
    }

    // Query methods
    async getActiveConnections() {
        return this.all('SELECT * FROM connections WHERE active = 1');
    }

    async getPendingUpdates(targetType, limit = 100) {
        return this.all(
            `SELECT * FROM updates 
             WHERE processed = 0 AND target_type = ?
             ORDER BY COALESCE(priority, 0) DESC, created_at ASC
             LIMIT ?`,
            [targetType, limit]
        );
    }

    // Connection Management
    async deleteConnection(connectionId) {
        return this.run(
            `UPDATE connections 
             SET active = 0, 
                 status = 'deleted',
                 last_sync_time = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [connectionId]
        );
    }

    async updateConnectionStatus(connectionId, status, error = null) {
        return this.run(
            `UPDATE connections 
             SET status = ?,
                 last_error = ?,
                 last_sync_time = CURRENT_TIMESTAMP,
                 retry_count = CASE 
                    WHEN ? = 'error' THEN retry_count + 1 
                    ELSE 0 
                 END
             WHERE id = ?`,
            [status, error, status, connectionId]
        );
    }

    // Update Management
    async markUpdatesProcessed(updateIds) {
        const placeholders = updateIds.map(() => '?').join(',');
        return this.run(
            `UPDATE updates 
             SET processed = 1,
                 processed_at = CURRENT_TIMESTAMP
             WHERE id IN (${placeholders})`,
            updateIds
        );
    }

    async getUnacknowledgedUpdates(targetType) {
        return this.all(
            `SELECT * FROM updates 
             WHERE processed = 1 
             AND acknowledged = 0 
             AND target_type = ?
             ORDER BY created_at ASC`,
            [targetType]
        );
    }

    // Sync Status Management
    async updateSyncStatus(connectionId, status = 'synced', error = null) {
        const id = `sync-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        return this.run(
            `INSERT INTO sync_status 
             (id, connection_id, status, last_error)
             VALUES (?, ?, ?, ?)`,
            [id, connectionId, status, error]
        );
    }

    // App State Management
    async updateAppLastSeen(appId) {
        return this.run(
            `UPDATE app_states 
             SET last_seen = CURRENT_TIMESTAMP 
             WHERE id = ?`,
            [appId]
        );
    }

    async getStaleApps(minutes = 5) {
        return this.all(
            `SELECT * FROM app_states 
             WHERE last_seen < datetime('now', '-' || ? || ' minutes')
             AND status = 'active'`,
            [minutes]
        );
    }

    // Error Management
    async getRecentErrors(appType, limit = 100) {
        return this.all(
            `SELECT * FROM error_logs 
             WHERE app_type = ? 
             ORDER BY created_at DESC 
             LIMIT ?`,
            [appType, limit]
        );
    }

    // Cleanup Methods
    async cleanupStaleData(minutes = 60) {
        const operations = [
            this.run(
                `DELETE FROM updates 
                 WHERE processed = 1 
                 AND created_at < datetime('now', '-' || ? || ' minutes')`,
                [minutes]
            ),
            this.run(
                `DELETE FROM error_logs 
                 WHERE created_at < datetime('now', '-' || ? || ' minutes')`,
                [minutes * 24] // Keep errors longer
            ),
            this.run(
                `DELETE FROM sync_status 
                 WHERE created_at < datetime('now', '-' || ? || ' minutes')`,
                [minutes]
            )
        ];
        
        await Promise.all(operations);
    }

    async monitorHealth() {
        const metrics = {
            connections: await this.all('SELECT COUNT(*) as count FROM connections WHERE active = 1'),
            pendingUpdates: await this.all('SELECT COUNT(*) as count FROM updates WHERE processed = 0'),
            errors: await this.all('SELECT COUNT(*) as count FROM error_logs WHERE created_at > datetime("now", "-1 hour")'),
            avgSyncTime: await this.all(`
                SELECT AVG(strftime('%s', last_sync_time) - strftime('%s', created_at)) as avg_time 
                FROM sync_status 
                WHERE created_at > datetime('now', '-1 hour')
            `)
        };

        // Alert if thresholds exceeded
        if (metrics.pendingUpdates[0].count > 1000) {
            console.warn('High number of pending updates:', metrics.pendingUpdates[0].count);
        }

        if (metrics.errors[0].count > 50) {
            console.error('High error rate detected:', metrics.errors[0].count);
        }

        return metrics;
    }

    async vacuum() {
        // Optimize database periodically
        await this.run('VACUUM');
        await this.run('ANALYZE');
    }

    async getMigrationVersion() {
        try {
            const result = await this.get('PRAGMA user_version');
            return result.user_version;
        } catch (error) {
            console.error('Failed to get migration version:', error);
            return 0;
        }
    }

    async setMigrationVersion(version) {
        try {
            await this.run(`PRAGMA user_version = ${version}`);
        } catch (error) {
            console.error('Failed to set migration version:', error);
            throw error;
        }
    }

    async runMigrations() {
        try {
            const currentVersion = await this.getMigrationVersion();
            console.log('Current database version:', currentVersion);

            for (const migration of MIGRATIONS) {
                if (migration.version > currentVersion) {
                    console.log(`Running migration ${migration.version}...`);
                    await this.run('BEGIN TRANSACTION');
                    try {
                        await migration.up(this);
                        await this.setMigrationVersion(migration.version);
                        await this.run('COMMIT');
                        console.log(`Migration ${migration.version} completed`);
                    } catch (error) {
                        await this.run('ROLLBACK');
                        console.error(`Migration ${migration.version} failed:`, error);
                        if (error.code !== 'SQLITE_ERROR') {
                            throw error;
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Migration failed:', error);
            throw error;
        }
    }

    // Update backup function to properly close backup
    async backup() {
        const backupPath = `${DB_CONFIG.filename}.backup-${Date.now()}`;
        return new Promise((resolve, reject) => {
            const backup = this.db.backup(backupPath);
            
            backup.step(-1, (err) => {
                if (err) {
                    console.error('Backup failed:', err);
                    reject(err);
                } else {
                    console.log('Backup completed:', backupPath);
                    backup.finish();
                    resolve(backupPath);
                }
            });
        });
    }
}

// Export singleton instance
const dbManager = new DatabaseManager();
export default dbManager; 