/** Automatic presentation must yield to author navigation or typing during a request. */
export function shouldPresentCandidate(input:{action:'discuss'|'generate'|'refine';requestNavigation:number;currentNavigation:number;authorBrowsing:boolean}):boolean{
 return input.action!=='discuss'&&input.requestNavigation===input.currentNavigation&&!input.authorBrowsing;
}
