class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function notFoundHandler(req, res) {
  res.status(404).json({ statusCode: 404, message: `Not found: ${req.method} ${req.originalUrl}` });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ statusCode: err.status, message: err.message });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ statusCode: 400, message: 'Invalid JSON body' });
  }
  const status = err.status || err.statusCode || 500;
  const message = err.message || 'Internal server error';
  if (status >= 500) {
    console.error('[mnt-api] unhandled error:', err);
  }
  res.status(status).json({ statusCode: status, message });
}

module.exports = { ApiError, asyncHandler, notFoundHandler, errorHandler };
