const path = require('node:path');
const { pathToFileURL } = require('node:url');

process.env.DB_PATH ||= path.join(process.env.MARION_APP_DATA, 'marion-agent.db');
process.env.DEV_LOGIN ??= '1';
delete process.env.MARION_APP_DATA;
import(pathToFileURL(path.resolve('dist/index.js')).href).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
