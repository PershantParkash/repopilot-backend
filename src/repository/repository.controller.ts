// repository.controller.ts
import { Controller, Post, Body, Get, Param } from '@nestjs/common';
import { RepositoryService } from './repository.service';
import { CloneRepoDto } from './dto/clone-repo.dto';

@Controller('repository')
export class RepositoryController {
  constructor(private readonly repositoryService: RepositoryService) {}

  @Post('clone')
  async clone(@Body() dto: CloneRepoDto) {
    return this.repositoryService.cloneRepository(dto.repoUrl);
  }

  @Post(':id/analyze')
  async analyze(@Param('id') id: string) {
    return this.repositoryService.analyzeRepository(id);
  }

    @Get(':id/findings')
getFindings(@Param('id') id: string) {
  return this.repositoryService.getFindings(id);
}

@Get(':id/findings/compact')
getFindingsCompact(@Param('id') id: string) {
  return this.repositoryService.getFindingsCompact(id);
}

  @Get(':id/components')
getComponents(@Param('id') id: string) {
  return this.repositoryService.getComponents(id);
}

@Get(':id/hooks')
getHooks(@Param('id') id: string) {
  return this.repositoryService.getHooks(id);
}

@Get(':id/graph')
getGraph(@Param('id') id: string) {
  return this.repositoryService.getGraph(id);
}

@Get(':id/findings/by-kind')
getFindingsByKind(@Param('id') id: string) {
  return this.repositoryService.getFindingsByKind(id);
}

  @Get()
  async findAll() {
    return this.repositoryService.findAll();
  }

}