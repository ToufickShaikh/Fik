// =============================================================================
// DEPRECATED — this file used to be a stand-alone /api/ingest stub on port
// 3000 that duplicated (and quietly mis-handled) the real backend at
// backend/server.js. Running both caused port collisions and the silent
// HTTP 400 responses you saw at upload time. The file is now a deliberate
// no-op so any leftover `node server.js` invocation exits cleanly.
//
// Use:  docker compose up backend   (or:  cd backend && npm start)
// =============================================================================
console.error(
  '[fik] root-level server.js is deprecated.\n' +
  '      Start the backend via:  docker compose up backend  (or: cd backend && npm start)'
);
process.exit(0);
