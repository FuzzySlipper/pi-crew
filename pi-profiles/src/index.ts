// pi-profiles — Agent personality, skill definitions, and system prompt assembly.
// Depends on: pi-core

export interface Skill {
  name: string;
  description: string;
  version: string;
}

export interface Profile {
  name: string;
  description: string;
  skills: Skill[];
}

export function loadProfile(name: string): Profile {
  return {
    name,
    description: `Profile: ${name}`,
    skills: [],
  };
}
