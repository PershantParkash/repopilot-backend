import { Module } from '@nestjs/common';
import { AnalyzerService } from './analyzer.service';
import { AstAnalyzerService } from './ast-analyzer.service';
import { DependencyGraphService } from './dependency-graph.service';
import { RulesEngineService } from './rules-engine.service';
import { FileDetailAnalyzerService } from './file-detail-analyzer.service';

@Module({
  providers: [AnalyzerService, AstAnalyzerService, DependencyGraphService, RulesEngineService, FileDetailAnalyzerService,],
  exports: [AnalyzerService, FileDetailAnalyzerService],
})
export class AnalyzerModule {}