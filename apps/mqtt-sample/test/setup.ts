import 'reflect-metadata';
import { logger } from '../src/logger';

// Keep test output readable; set LOG_LEVEL=debug to see service logs.
logger.level = (process.env.LOG_LEVEL as typeof logger.level) ?? 'silent';
