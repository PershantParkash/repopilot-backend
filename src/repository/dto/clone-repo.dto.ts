import { IsString, Matches } from 'class-validator';

export class CloneRepoDto {
  @IsString()
  @Matches(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?\/?$/, {
    message: 'Must be a valid public GitHub repository URL',
  })
  repoUrl!: string;
}