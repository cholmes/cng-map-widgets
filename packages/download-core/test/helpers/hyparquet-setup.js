// Test-only: inject the npm-installed hyparquet/hyparquet-writer packages
// in place of download-core's dynamic CDN imports (see src/cdn.js's module
// doc comment for why plain `node --test` needs this). Import this module
// (for its side effect) before any test that calls estimate()/download()
// against real or synthetic parquet data.

import * as hyparquet from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import * as hyparquetWriter from 'hyparquet-writer';
import { setHyparquetModules } from '../../src/cdn.js';

setHyparquetModules({ hyparquet, compressors, writer: hyparquetWriter });
