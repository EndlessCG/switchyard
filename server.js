#!/usr/bin/env node
'use strict';
const fs = require('fs');
const { loadConfig, defaultConfigPath, ConfigError } = require('./hub/config');
const { FleetState } = require('./hub/state');
const { HostLink, COLLECTOR_PATH } = require('./hub/host-link');
const { Dashboard, StateFileError } = require('./hub/dashboard');
const { StatusLogError } = require('./hub/status-log');
const { StepLogError } = require('./hub/step-log');
const { Notes, NotesFileError } = require('./hub/notes');
const { createApp } = require('./hub/routes');
const { DemoLink, demoConfig } = require('./hub/demo');

function configPathFromArgs(argv) {
  const i = argv.indexOf('--config');
  if (i >= 0) {
    if (!argv[i + 1]) throw new Error('--config needs a file path');
    return argv[i + 1];
  }
  return process.env.SWITCHYARD_CONFIG || defaultConfigPath();
}

function main() {
  const argv = process.argv.slice(2);
  // --demo: a made-up fleet (hub/demo.js) instead of real servers; nothing real is read.
  const demo = argv.includes('--demo');
  const file = demo ? 'demo' : configPathFromArgs(argv);
  const config = demo ? demoConfig() : loadConfig(file);
  const state = new FleetState(config.hosts.map((h) => h.name));
  const dashboard = new Dashboard(state, { stateFile: config.stateFile, statusLogFile: config.statusLogFile,
    stepLogFile: config.stepLogFile });
  const notes = new Notes({ file: config.notesFile });
  const Link = demo ? DemoLink : HostLink;
  const links = config.hosts.map((host) => new Link({ host, config, state }));
  dashboard.on('host', (h) => {
    if (h.status === 'offline' || h.status === 'error') console.error(`[${h.name}] ${h.status}: ${h.error}`);
  });
  const collectorSource = fs.readFileSync(COLLECTOR_PATH, 'utf8');
  const server = createApp(dashboard, { config, collectorSource, notes }).listen(config.port, '127.0.0.1', () => {
    console.log(`Switchyard${demo ? ' demo' : ''}: http://127.0.0.1:${config.port}  (${demo ? 'made-up servers' : `config: ${file}`})`);
    links.forEach((l) => l.start());
  });
  server.on('error', (err) => {
    console.error(`Switchyard couldn't listen on 127.0.0.1:${config.port}: ${err.message}`);
    process.exit(1);
  });
  const shutdown = () => {
    links.forEach((l) => l.stop());
    if (demo) fs.rmSync(config.demoDir, { recursive: true, force: true });
    server.closeAllConnections(); // open SSE streams would otherwise keep the server alive
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof ConfigError || err instanceof StateFileError || err instanceof StatusLogError
      || err instanceof StepLogError || err instanceof NotesFileError ? err.message : err.stack);
    process.exit(1);
  }
}

module.exports = { configPathFromArgs };
