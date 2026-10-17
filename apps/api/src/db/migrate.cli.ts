import { loadConfig } from '../config';
import { migrate } from './migrate';

migrate(loadConfig().migrationDatabaseUrl)
  .then(() => {
    console.log('migrations complete');
    process.exit(0);
  })
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
