// entities/repository.entity.ts
import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm';

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

  @Column({ default: 'pending' })
  status!: 'pending' | 'cloning' | 'completed' | 'failed';

  @Column({ nullable: true })
  errorMessage!: string;

  @Column({ type: 'jsonb', nullable: true })
  analysis!: Record<string, any>;   // <-- NEW: stores analyzer output

  @CreateDateColumn()
  createdAt!: Date;
}