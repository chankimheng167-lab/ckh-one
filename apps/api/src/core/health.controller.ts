import { Controller, Get } from '@nestjs/common';
import { Public } from '../common/auth-context';
import { DatabaseService } from '../db/database.service';

@Controller('health')
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

  @Public()
  @Get()
  async health() {
    await this.db.pool.query('SELECT 1');
    return { status: 'ok' };
  }
}
