import { afterEach, beforeEach } from 'vitest';
import { judgeOwnCpu } from './limits.ts';

judgeOwnCpu({ beforeEach, afterEach });
