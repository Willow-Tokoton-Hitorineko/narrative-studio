import {describe,it,expect} from 'vitest';
import {shouldPresentCandidate} from '../../apps/studio/src/candidate-presentation.js';
describe('Candidate reading presentation respects author intent',()=>{
 it('opens generation and refinement in reading view after an uninterrupted request',()=>{
  for(const action of ['generate','refine'] as const)expect(shouldPresentCandidate({action,requestNavigation:4,currentNavigation:4,authorBrowsing:false})).toBe(true);
 });
 it('never switches to candidate reading after a discussion reply',()=>{
  expect(shouldPresentCandidate({action:'discuss',requestNavigation:4,currentNavigation:4,authorBrowsing:false})).toBe(false);
 });
 it('keeps the author-selected view when layout or tab changes during a request',()=>{
  expect(shouldPresentCandidate({action:'generate',requestNavigation:4,currentNavigation:5,authorBrowsing:false})).toBe(false);
 });
 it('does not interrupt reading or the next typed instruction while awaiting a candidate',()=>{
  expect(shouldPresentCandidate({action:'generate',requestNavigation:4,currentNavigation:4,authorBrowsing:true})).toBe(false);
 });
});
