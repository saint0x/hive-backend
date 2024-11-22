import express from 'express';
import { createServer } from 'http';
import morgan from 'morgan';
import cors from 'cors';
import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { promisify } from 'util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Constants for configuration
const CONFIG = {
  MAX_STALE_TIME_MINUTES: 5,
  MIN_UPDATE_INTERVAL_MS: 1000,
  MAX_BATCH_SIZE: 100,
  DEFAULT_PAGE_SIZE: 50
};

const app = express();
const httpServer = createServer(app);
const port = process.env.PORT || 3000;

// Initialize SQLite with WAL mode for better concurrent performance
const db = new sqlite3.Database('hive.db', (err) => {
  if (err) {
    console.error('Database initialization error:', err);
    process.exit(1);
  }
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA synchronous = NORMAL');
});

const dbRun = promisify(db.run.bind(db));
const dbAll = promisify(db.all.bind(db));
const dbGet = promisify(db.get.bind(db));

// Error logging utility
const logError = (error, context) => {
  const timestamp = new Date().toISOString();
  const errorDetails = {
    timestamp,
    context,
    message: error.message,
    stack: error.stack,
    details: error.details || {}
  };
  console.error(JSON.stringify(errorDetails, null, 2));
  return errorDetails;
};

// Input validation middleware
const validateConnection = (req, res, next) => {
  const { cellId, slideElementId } = req.body;
  const errors = [];
  
  if (!cellId || typeof cellId !== 'string') {
    errors.push('Cell ID is required and must be a string');
  } else if (!cellId.includes('!')) {
    errors.push('Cell ID must be in format: SheetName!CellReference');
  }

  if (!slideElementId || typeof slideElementId !== 'string') {
    errors.push('Slide element ID is required and must be a string');
  }

  if (errors.length > 0) {
    const error = new Error('Validation failed');
    error.details = errors;
    return res.status(400).json({
      success: false,
      error: logError(error, 'Connection validation')
    });
  }

  next();
};

const validateUpdate = (req, res, next) => {
  const { connectionId, value, timestamp } = req.body;
  const errors = [];
  
  if (!connectionId || typeof connectionId !== 'string') {
    errors.push('Connection ID is required and must be a string');
  }

  if (value === undefined) {
    errors.push('Value is required');
  }

  if (timestamp && isNaN(Date.parse(new Date(timestamp)))) {
    errors.push('Invalid timestamp format');
  }

  if (errors.length > 0) {
    const error = new Error('Validation failed');
    error.details = errors;
    return res.status(400).json({
      success: false,
      error: logError(error, 'Update validation')
    });
  }

  next();
};

// Initialize database tables
async function initializeDatabase() {
  try {
    await dbRun(`
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        cell_id TEXT NOT NULL,
        slide_element_id TEXT NOT NULL,
        original_cell_id TEXT NOT NULL,
        active BOOLEAN DEFAULT 1,
        sync_enabled BOOLEAN DEFAULT 1,
        last_sync_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(original_cell_id, slide_element_id)
      )
    `);

    await dbRun(`
      CREATE TABLE IF NOT EXISTS updates (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        source_type TEXT NOT NULL,
        target_type TEXT NOT NULL,
        content TEXT NOT NULL,
        processed BOOLEAN DEFAULT 0,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('Database initialized successfully');
  } catch (error) {
    const errorDetails = logError(error, 'Database initialization');
    throw new Error(`Database initialization failed: ${errorDetails.message}`);
  }
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// Routes
app.post('/api/register', async (req, res) => {
  const { type } = req.body;
  
  if (!['sheets', 'slides'].includes(type)) {
    const error = new Error('Invalid application type');
    error.details = { allowedTypes: ['sheets', 'slides'], received: type };
    return res.status(400).json({
      success: false,
      error: logError(error, 'Registration validation')
    });
  }

  try {
    const initialState = await getInitialData();
    res.json({ success: true, type, initialState });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: logError(error, 'Registration')
    });
  }
});

app.post('/api/selection/:type/broadcast', async (req, res) => {
  const { type } = req.params;
  const { selection, element } = req.body;
  
  const content = type === 'sheets' ? selection : element;

  if (!content) {
    const error = new Error('Missing selection data');
    error.details = { type, receivedContent: !!content };
    return res.status(400).json({
      success: false,
      error: logError(error, 'Selection broadcast validation')
    });
  }

  try {
    const id = `upd-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    await dbRun(
      `INSERT INTO updates (id, type, source_type, target_type, content)
       VALUES (?, 'selection', ?, ?, ?)`,
      [id, type, type === 'sheets' ? 'slides' : 'sheets', JSON.stringify(content)]
    );

    const update = await dbGet('SELECT * FROM updates WHERE id = ?', [id]);
    res.json({ success: true, update });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: logError(error, 'Selection broadcast')
    });
  }
});

app.get('/api/updates/:type', async (req, res) => {
  const { type } = req.params;
  const { lastUpdate } = req.query;
  
  try {
    const updates = await dbAll(
      `SELECT * FROM updates 
       WHERE target_type = ? 
       AND processed = 0 
       AND timestamp > datetime(?, 'unixepoch', 'millisecond')
       ORDER BY timestamp ASC
       LIMIT ?`,
      [type, lastUpdate, CONFIG.MAX_BATCH_SIZE]
    );
    res.json({ success: true, updates });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: logError(error, 'Updates fetch')
    });
  }
});

app.post('/api/connections', validateConnection, async (req, res) => {
  const { cellId, slideElementId } = req.body;

  try {
    const existingConnection = await dbGet(
      'SELECT * FROM connections WHERE original_cell_id = ? AND slide_element_id = ?',
      [cellId, slideElementId]
    );

    if (existingConnection) {
      if (!existingConnection.active) {
        await dbRun(
          `UPDATE connections 
           SET active = 1, sync_enabled = 1, last_sync_time = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [existingConnection.id]
        );
        const updatedConnection = await dbGet(
          'SELECT * FROM connections WHERE id = ?',
          [existingConnection.id]
        );
        return res.json({ success: true, connection: updatedConnection });
      }
      return res.json({ success: true, connection: existingConnection });
    }

    const id = `conn-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    await dbRun(
      `INSERT INTO connections (id, cell_id, slide_element_id, original_cell_id)
       VALUES (?, ?, ?, ?)`,
      [id, cellId, slideElementId, cellId]
    );

    const connection = await dbGet('SELECT * FROM connections WHERE id = ?', [id]);
    res.json({ success: true, connection });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: logError(error, 'Connection creation')
    });
  }
});

app.put('/api/connections/:id', async (req, res) => {
  const { id } = req.params;
  const { active, syncEnabled, cellId } = req.body;

  try {
    if (cellId) {
      await dbRun(
        `UPDATE connections 
         SET cell_id = ?, active = ?, sync_enabled = ?, last_sync_time = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [cellId, active, syncEnabled, id]
      );
    } else {
      await dbRun(
        `UPDATE connections 
         SET active = ?, sync_enabled = ?, last_sync_time = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [active, syncEnabled, id]
      );
    }

    const connection = await dbGet('SELECT * FROM connections WHERE id = ?', [id]);
    if (!connection) {
      throw new Error('Connection not found after update');
    }
    res.json({ success: true, connection });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: logError(error, 'Connection update')
    });
  }
});

app.post('/api/updates/acknowledge', async (req, res) => {
  const { updateIds } = req.body;

  if (!Array.isArray(updateIds)) {
    const error = new Error('Invalid update IDs');
    error.details = { received: typeof updateIds };
    return res.status(400).json({
      success: false,
      error: logError(error, 'Update acknowledgment validation')
    });
  }

  try {
    const placeholders = updateIds.map(() => '?').join(',');
    await dbRun(
      `UPDATE updates SET processed = 1 WHERE id IN (${placeholders})`,
      updateIds
    );

    res.json({ success: true, processed: updateIds.length });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: logError(error, 'Update acknowledgment')
    });
  }
});

app.get('/api/connections/health', async (req, res) => {
  try {
    const staleConnections = await dbAll(
      `SELECT * FROM connections 
       WHERE active = 1 
       AND last_sync_time < datetime('now', '-${CONFIG.MAX_STALE_TIME_MINUTES} minutes')`
    );

    res.json({ 
      success: true, 
      staleConnections,
      timestamp: new Date()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: logError(error, 'Connection health check')
    });
  }
});

app.post('/api/updates/cell', validateUpdate, async (req, res) => {
  const { connectionId, value, timestamp } = req.body;

  try {
    const connection = await dbGet(
      'SELECT * FROM connections WHERE id = ?',
      [connectionId]
    );

    if (!connection) {
      const error = new Error('Connection not found');
      error.details = { connectionId };
      return res.status(404).json({
        success: false,
        error: logError(error, 'Cell update - connection lookup')
      });
    }

    const id = `upd-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    await dbRun(
      `INSERT INTO updates (id, type, source_type, target_type, content)
       VALUES (?, 'value', 'sheets', 'slides', ?)`,
      [id, JSON.stringify({
        connectionId,
        value,
        slideElementId: connection.slide_element_id,
        cellId: connection.cell_id,
        originalCellId: connection.original_cell_id
      })]
    );

    await dbRun(
      `UPDATE connections 
       SET last_sync_time = datetime(?, 'unixepoch', 'millisecond')
       WHERE id = ?`,
      [timestamp || Date.now(), connectionId]
    );

    const update = await dbGet('SELECT * FROM updates WHERE id = ?', [id]);
    res.json({ success: true, update });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: logError(error, 'Cell update')
    });
  }
});

// Helper functions
async function getInitialData() {
  try {
    const [activeConnections, pendingUpdates] = await Promise.all([
      dbAll('SELECT * FROM connections WHERE active = 1'),
      dbAll(
        `SELECT * FROM updates 
         WHERE processed = 0 
         ORDER BY timestamp ASC 
         LIMIT ?`,
        [CONFIG.DEFAULT_PAGE_SIZE]
      )
    ]);

    return {
      connections: activeConnections,
      updates: pendingUpdates
    };
  } catch (error) {
    throw logError(error, 'Initial data fetch');
  }
}

// Error handling middleware
app.use((err, req, res, next) => {
  const errorDetails = logError(err, 'Unhandled error');
  res.status(500).json({
    success: false,
    error: errorDetails
  });
});

// Start server
async function startServer() {
  try {
    await initializeDatabase();
    httpServer.listen(port, () => {
      console.log(`Server running on port ${port}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}

export default app;
