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

  @Get()
  async findAll() {
    return this.repositoryService.findAll();
  }
}