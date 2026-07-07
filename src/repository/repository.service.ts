import { Injectable, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { simpleGit } from 'simple-git';
import * as path from 'path';
import * as fs from 'fs';
import { RepositoryEntity } from '../entities/repository.entity';
import { AnalyzerService } from 'src/analyzer/analyzer.service';
import { DependencyGraphService } from 'src/analyzer/dependency-graph.service';
import { FullAnalysis } from 'src/analyzer/analyzer.service';
import { FileDetailAnalyzerService } from 'src/analyzer/file-detail-analyzer.service';
import { toCompactFileDetails } from 'src/analyzer/file-detail-serializer';

const CLONE_BASE_DIR = path.join(process.cwd(), 'Review Project');

@Injectable()
export class RepositoryService {
 constructor(
  @InjectRepository(RepositoryEntity)
  private readonly repoRepository: Repository<RepositoryEntity>,
  private readonly analyzerService: AnalyzerService,
  private readonly fileDetailAnalyzer: FileDetailAnalyzerService,
) {}

  private extractRepoName(url: string): string {
    const cleaned = url.replace(/\.git$/, '').replace(/\/$/, '');
    const name = cleaned.split('/').pop();
    if (!name) throw new BadRequestException('Could not parse repository name from URL');
    // sanitize to prevent path traversal
    return name.replace(/[^a-zA-Z0-9-_]/g, '');
  }

  async cloneRepository(repoUrl: string) {
    const repoName = this.extractRepoName(repoUrl);
    const targetPath = path.join(CLONE_BASE_DIR, repoName);

    if (fs.existsSync(targetPath)) {
      throw new ConflictException(`Repository "${repoName}" already exists locally`);
    }

    if (!fs.existsSync(CLONE_BASE_DIR)) {
      fs.mkdirSync(CLONE_BASE_DIR, { recursive: true });
    }

    // create DB record first (status: pending)
    const record = this.repoRepository.create({
      repoUrl,
      repoName,
      localPath: targetPath,
      status: 'pending',
    });
    await this.repoRepository.save(record);

    try {
      record.status = 'cloning';
      await this.repoRepository.save(record);

      const git = simpleGit();
      await git.clone(repoUrl, targetPath, ['--depth', '1']); // shallow clone by default

      record.status = 'completed';
      await this.repoRepository.save(record);

      return record;
    } catch (error) {
      record.status = 'failed';
      record.errorMessage = error.message;
      await this.repoRepository.save(record);

      // cleanup partial clone
      if (fs.existsSync(targetPath)) {
        fs.rmSync(targetPath, { recursive: true, force: true });
      }

      throw new BadRequestException(
        `Failed to clone repository: ${error.message}`,
      );
    }
  }

async getFindings(id: string) {
  const record = await this.getAnalyzedRecord(id);
  const findings = record.analysis?.findings ?? [];
  return this.fileDetailAnalyzer.analyzeAll(record.localPath, findings);
}

async getFindingsCompact(id: string) {
  const details = await this.getFindings(id);
  return toCompactFileDetails(details);
}

async getFindingsByKind(id: string) {
  const record = await this.getAnalyzedRecord(id);
  const findings = record.analysis?.findings ?? [];
  const details = this.fileDetailAnalyzer.analyzeAll(record.localPath, findings);
  return this.fileDetailAnalyzer.groupByKind(details);
}

 async analyzeRepository(id: string) {
  const record = await this.repoRepository.findOneBy({ id });
  if (!record) throw new NotFoundException('Repository record not found');
  if (record.status !== 'completed') {
    throw new BadRequestException(`Repository is not ready (status: ${record.status})`);
  }

  // one crawl produces the full analysis; we persist it once...
  const fullAnalysis = await this.analyzerService.analyze(record.localPath);
  record.analysis = fullAnalysis;
  await this.repoRepository.save(record);

  // ...and only ever hand the lean summary back from this endpoint
  return this.analyzerService.toSummary(fullAnalysis);
}

async getComponents(id: string) {
  const record = await this.getAnalyzedRecord(id);
  return this.analyzerService.getComponents(record.analysis);
}

async getHooks(id: string) {
  const record = await this.getAnalyzedRecord(id);
  return this.analyzerService.getHooks(record.analysis);
}

async getGraph(id: string) {
  const record = await this.getAnalyzedRecord(id);
  return this.analyzerService.getGraph(record.analysis);
}

private async getAnalyzedRecord(
  id: string,
): Promise<RepositoryEntity & { analysis: FullAnalysis }> {
  const record = await this.repoRepository.findOneBy({ id });
  if (!record) throw new NotFoundException('Repository record not found');
  if (!record.analysis) {
    throw new BadRequestException('Repository has not been analyzed yet');
  }
  // Safe: we just verified analysis is non-null above.
  return record as RepositoryEntity & { analysis: FullAnalysis };
}


  async findAll() {
    return this.repoRepository.find({ order: { createdAt: 'DESC' } });
  }
}