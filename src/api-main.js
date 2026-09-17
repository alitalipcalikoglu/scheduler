import { Application } from './application.js';

// HTTP only: job/run management and read-only stats, no Worker — never claims a run. See
// Application's "role" doc for what this changes about readiness/stats.
await Application.fromEnv({ role: 'api' }).start();
