import { Module } from '@nestjs/common';
import { AnalyzerService } from './analyzer.service';
import { AstAnalyzerService } from './ast-analyzer.service';
import { DependencyGraphService } from './dependency-graph.service';

@Module({
  providers: [AnalyzerService, AstAnalyzerService, DependencyGraphService],
  exports: [AnalyzerService],
})
export class AnalyzerModule {}