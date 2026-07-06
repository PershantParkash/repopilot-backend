// entities/repository.entity.ts
import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm';
import type { FullAnalysis } from '../analyzer/analyzer.service';

@Entity()
export class RepositoryEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  repoUrl!: string;

  @Column()
  repoName!: string;

  @Column()
  localPath!: string;

  @Column()
  status!: 'pending' | 'cloning' | 'completed' | 'failed';

  @Column({ nullable: true })
  errorMessage?: string;

  @Column({ type: 'jsonb', nullable: true })
  analysis!: FullAnalysis | null;

  @CreateDateColumn()
  createdAt!: Date;
}