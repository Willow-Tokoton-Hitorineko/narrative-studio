import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {execFile} from 'node:child_process';
const invoke=vi.fn();
import {openStudioBrowser} from '../../apps/cli/src/studio/open-browser.js';
describe('Windows Studio browser handoff',()=>{
 beforeEach(()=>{invoke.mockReset();});
 it('passes the entire authenticated URL as data, never interpolated shell commands',async()=>{
  invoke.mockImplementation((_file,_args,_options,done)=>done(null));
  const url='http://127.0.0.1:61952/?token=synthetic&next=%22%3Bcalc';
  await openStudioBrowser(url,invoke as unknown as typeof execFile);
  const [file,args,options]=invoke.mock.calls[0]!;
  expect(file).toContain('powershell.exe');expect(args.join(' ')).not.toContain(url);
  expect(options.env.NS_STUDIO_BROWSER_URL).toBe(url);expect(options.windowsHide).toBe(true);expect(options.timeout).toBe(10000);
 });
 it('surfaces a failed browser association instead of reporting an unchecked successful spawn',async()=>{
  invoke.mockImplementation((_file,_args,_options,done)=>done(new Error('no browser association')));
  await expect(openStudioBrowser('http://127.0.0.1:61952/?token=synthetic',invoke as unknown as typeof execFile)).rejects.toThrow('no browser association');
 });
 it('never delegates remote URLs, files or URLs with embedded credentials',async()=>{
  for(const url of ['https://example.com','file:///C:/Windows/notepad.exe','http://user:pass@localhost:1234/'])await expect(openStudioBrowser(url,invoke as unknown as typeof execFile)).rejects.toThrow('Only local');
  expect(invoke).not.toHaveBeenCalled();
 });
});
