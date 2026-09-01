/*
 * What the sharing setting will say about the projects actually on this machine.
 *
 * A probe and not a test: it reads real folders, so its answers change when the
 * disk does. It exists because the first `hasGit` was wrong in a way no fixture
 * would have caught — the thesis has no `.git` of its own and sits inside one,
 * and only a real path says so.
 *
 *     bun run dev/sharing.probe.ts
 */
import { hasGit, sharesKehikot } from '../server/projects.ts'

const projects = [
  '/Users/jaakkorajala/Projects/roadmap',
  '/Users/jaakkorajala/Claude/Projects/CS-DEGREE/05_drafts/thesis_latex',
  '/Users/jaakkorajala/Projects/hippos_kotisivut/hippos-portal',
]

for (const path of projects) {
  const name = path.split('/').slice(-1)[0] ?? path
  console.log(`${name.padEnd(16)} git: ${String(hasGit(path)).padEnd(6)} shared: ${sharesKehikot(path)}`)
}
