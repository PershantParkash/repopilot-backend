// repository.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RepositoryController } from './repository.controller';
import { RepositoryService } from './repository.service';
import { RepositoryEntity } from '../entities/repository.entity';
import { AnalyzerModule } from '../analyzer/analyzer.module';  

@Module({
  imports: [TypeOrmModule.forFeature([RepositoryEntity]),  AnalyzerModule],
  controllers: [RepositoryController],
  providers: [RepositoryService],
})
export class RepositoryModule {}