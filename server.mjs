import express from 'express';
import morgan from 'morgan';
import cors from 'cors';
import dbManager from './db.mjs';

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use((req, res, next) => {
    if (req.url.startsWith('/socket.io/')) {
        return res.status(404).end();
    }
    next();
});

app.use(cors());
app.use(express.json());
app.use(morgan('dev', {
    skip: (req, res) => req.url.startsWith('/socket.io/')
}));

// Input validation middleware
function validateConnection(req, res, next) {
  const { cellId, slideElementId } = req.body;
  if (!cellId || !slideElementId) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields'
    });
  }
  next();
}

function validateUpdate(req, res, next) {
  const { connectionId, value } = req.body;
  if (!connectionId || value === undefined) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields'
    });
  }
  next();
}

// Error logging utility
function logError(error, context) {
  const errorDetails = {
    timestamp: new Date().toISOString(),
    context,
    message: error.message,
    stack: error.stack,
    details: error.details || {}
  };
  console.error(JSON.stringify(errorDetails, null, 2));
  return errorDetails;
}

// Routes
app.post('/api/register', async (req, res) => {
  const { type } = req.body;
  
  if (!['sheets', 'slides'].includes(type)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid application type'
    });
  }

  try {
    const initialState = await getInitialData();
    const appId = `app-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    await dbManager.updateAppState({
      id: appId,
      appType: type,
      status: 'active',
      connectionCount: initialState.connections.length,
      metadata: JSON.stringify({ registeredAt: Date.now() })
    });

    res.json({ 
      success: true, 
      type, 
      initialState,
      appId // Return appId for future reference
    });
  } catch (error) {
    await dbManager.logError(error, type);
    res.status(500).json({
      success: false,
      error: logError(error, 'Registration')
    });
  }
});

app.post('/api/selection/:type/broadcast', async (req, res) => {
  const { type } = req.params;
  const { selection, element, timestamp = Date.now() } = req.body;
  
  const content = type === 'sheets' ? selection : element;
  if (!content) {
    return res.status(400).json({
      success: false,
      error: 'Missing selection data'
    });
  }

  try {
    const id = `upd-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    await dbManager.insertUpdate({
      id,
      type: 'selection',
      sourceType: type,
      targetType: type === 'sheets' ? 'slides' : 'sheets',
      content,
      priority: 1 // High priority for selection updates
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: logError(error, 'Selection broadcast')
    });
  }
});

app.get('/api/updates/:type', async (req, res) => {
  const { type } = req.params;
  const { lastUpdate = 0 } = req.query;
  
  try {
    const updates = await dbManager.getPendingUpdates(type, CONFIG.MAX_BATCH_SIZE);
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
    const id = `conn-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    await dbManager.insertConnection({
      id,
      cellId,
      slideElementId,
      originalCellId: cellId
    });

    const connection = await dbManager.get('SELECT * FROM connections WHERE id = ?', [id]);
    res.json({ success: true, connection });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: logError(error, 'Connection creation')
    });
  }
});

app.delete('/api/connections/:id', async (req, res) => {
  const { id } = req.params;

  try {
    await dbManager.deleteConnection(id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: logError(error, 'Connection deletion')
    });
  }
});

app.post('/api/updates/acknowledge', async (req, res) => {
  const { updateIds } = req.body;

  if (!Array.isArray(updateIds)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid update IDs'
    });
  }

  try {
    await dbManager.markUpdatesProcessed(updateIds);
    res.json({ success: true, processed: updateIds.length });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: logError(error, 'Update acknowledgment')
    });
  }
});

app.post('/api/updates/cell', validateUpdate, async (req, res) => {
  const { connectionId, value, timestamp = Date.now() } = req.body;

  try {
    const connection = await dbManager.get(
      'SELECT * FROM connections WHERE id = ?',
      [connectionId]
    );

    if (!connection) {
      return res.status(404).json({
        success: false,
        error: 'Connection not found'
      });
    }

    const id = `upd-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    await dbManager.insertUpdate({
      id,
      type: 'value',
      sourceType: 'sheets',
      targetType: 'slides',
      content: {
        connectionId,
        value,
        slideElementId: connection.slide_element_id,
        cellId: connection.cell_id
      }
    });

    await dbManager.updateSyncStatus(connectionId, 'synced');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: logError(error, 'Cell update')
    });
  }
});

// Health check endpoint for monitoring
app.get('/api/health', async (req, res) => {
  try {
    const metrics = await dbManager.monitorHealth();
    const staleApps = await dbManager.getStaleApps(CONFIG.MAX_STALE_TIME_MINUTES);
    
    res.json({ 
      success: true, 
      metrics,
      staleApps,
      uptime: process.uptime(),
      timestamp: new Date(),
      config: {
        MAX_STALE_TIME_MINUTES: CONFIG.MAX_STALE_TIME_MINUTES,
        MIN_UPDATE_INTERVAL_MS: CONFIG.MIN_UPDATE_INTERVAL_MS,
        MAX_BATCH_SIZE: CONFIG.MAX_BATCH_SIZE
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: logError(error, 'Health check')
    });
  }
});

// Helper functions
async function getInitialData() {
  try {
    const [activeConnections, pendingUpdates] = await Promise.all([
      dbManager.getActiveConnections(),
      dbManager.getPendingUpdates('all', CONFIG.DEFAULT_PAGE_SIZE)
    ]);

    return {
      connections: activeConnections,
      updates: pendingUpdates
    };
  } catch (error) {
    throw error;
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
    await dbManager.initialize();
    
    // Be explicit about host binding for Codespaces
    app.listen(port, '0.0.0.0', () => {
      console.log(`Server running on port ${port}`);
      console.log(`Process ID: ${process.pid}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Add graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  await dbManager.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received. Shutting down gracefully...');
  await dbManager.close();
  process.exit(0);
});

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}

export default app;
