/**
 * jest `setupFiles`: point `compile()` at the warmed cache inside every test
 * realm. See `compile-cache.ts` for the measurement that motivated this.
 */
import { installCompileCache } from './compile-cache';

installCompileCache();

export {};
