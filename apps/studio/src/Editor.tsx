import {shouldAutoFollow} from './scroll-policy';
import {createAiRangeField,aiRangeHistory,revisionTransaction,type AiRange} from './editor-history';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Compartment, type StateField, EditorState } from '@codemirror/state';
import { Decoration, EditorView, drawSelection, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, redo, undo,undoDepth,redoDepth,selectAll,isolateHistory } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';

export interface EditorHandle {
  getValue: () => string;
  reveal:(start:number,end:number)=>void;
  shouldFollow:(start:number,end:number)=>boolean;
  snapshot:()=>{scrollTop:number;start:number;end:number};
  restore:(snapshot:{scrollTop:number;start:number;end:number})=>void;
  getAiRanges:()=>Array<{start:number;end:number}>;
  setValue: (text: string,ranges?:AiRange[]) => void;
  edit: (action:'cut'|'copy'|'paste'|'selectAll') => Promise<void>;
  focus: () => void;
  undo: () => void;
  redo: () => void;
  setSelection: (start: number, end: number) => void;
  getSelection: () => { start: number; end: number };
}

interface EditorProps {
  initialValue: string;
  readOnly?:boolean;
  initialAiRanges?:Array<{start:number;end:number}>;
  onChange: () => void;
  onSave: () => void;
  onSelectionChange?: (range:{start:number;end:number}) => void;
  onHistoryChange?: (status:{canUndo:boolean;canRedo:boolean;hasSelection:boolean}) => void;
}

const theme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'transparent',
    color: 'var(--ink)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-body, var(--font-serif))',
    fontSize: 'var(--body-size)',
    lineHeight: 'var(--body-leading)',
    padding: '0',
    overflow: 'auto',
  },
  '.cm-content': {
    padding: '0',
    caretColor: 'var(--accent)',
    textAlign: 'justify',
    textJustify: 'inter-ideograph',
    letterSpacing: '0.01em',
  },
  '.cm-line': { padding: '0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '.cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--selection) !important',
  },
  '.cm-panels': { backgroundColor: 'var(--canvas)', color: 'var(--ink)' },
  '.cm-gutters': { display: 'none' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-placeholder': { color: 'var(--muted)' },
});

const Editor = forwardRef<EditorHandle, EditorProps>(function Editor(props, ref) {
  const editable=useRef(new Compartment());
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const suppress = useRef(false);
  const aiField=useRef<StateField<Array<{start:number;end:number}>>|null>(null);
  const onChangeRef = useRef(props.onChange);
  const onSaveRef = useRef(props.onSave);
  const onSelectionRef = useRef(props.onSelectionChange);
  const onHistoryRef=useRef(props.onHistoryChange);
  onHistoryRef.current=props.onHistoryChange;
  onChangeRef.current = props.onChange;
  onSaveRef.current = props.onSave;
  onSelectionRef.current = props.onSelectionChange;

  useEffect(() => {
    if (!host.current) return;
    const marks=createAiRangeField(props.initialAiRanges??[]);
    aiField.current=marks;
    const state = EditorState.create({
      doc: props.initialValue,
      extensions: [
        editable.current.of(EditorState.readOnly.of(Boolean(props.readOnly))),
        marks,
        EditorView.decorations.from(marks,ranges=>Decoration.set(ranges.map(r=>Decoration.mark({class:'ai-adopted-text',attributes:{title:'AI 草拟 · 已由作者采用'}}).range(r.start,r.end)),true)),
        history(),
        aiRangeHistory(marks),
        drawSelection(),
        EditorView.lineWrapping,
        markdown(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([
          {
            key: 'Mod-s',
            run: () => {
              onSaveRef.current();
              return true;
            },
          },
          {key:'Mod-Shift-z',run:redo,preventDefault:true},
          ...historyKeymap,
          ...defaultKeymap,
        ]),
        theme,
        EditorView.contentAttributes.of({
          'aria-label': '正文编辑器',
          'aria-multiline': 'true',
          lang: 'zh-CN',
          spellcheck: 'false',
        }),
        EditorView.updateListener.of((update) => {
          if(update.docChanged||update.selectionSet)onHistoryRef.current?.({canUndo:undoDepth(update.state)>0,canRedo:redoDepth(update.state)>0,hasSelection:!update.state.selection.main.empty});
          if (update.docChanged && !suppress.current) onChangeRef.current();
          if(!suppress.current&&update.view.hasFocus&&(update.selectionSet||update.focusChanged||update.docChanged)){
            const range=update.state.selection.main;onSelectionRef.current?.({start:range.from,end:range.to});
          }
        }),
      ],
    });
    const instance = new EditorView({ state, parent: host.current });
    view.current = instance;
    onHistoryRef.current?.({canUndo:false,canRedo:false,hasSelection:false});
    return () => {
      instance.destroy();
      view.current = null;
    };
    // The editor is mounted once; chapter switches use setValue.
  }, []);

  useEffect(()=>{view.current?.dispatch({effects:editable.current.reconfigure(EditorState.readOnly.of(Boolean(props.readOnly)))});},[props.readOnly]);

  useImperativeHandle(
    ref,
    (): EditorHandle => ({
      snapshot:()=>({scrollTop:view.current?.scrollDOM.scrollTop??0,start:view.current?.state.selection.main.from??0,end:view.current?.state.selection.main.to??0}),
      restore:(s)=>{const v=view.current;if(!v)return;v.dispatch({selection:{anchor:Math.min(s.start,v.state.doc.length),head:Math.min(s.end,v.state.doc.length)}});v.scrollDOM.scrollTop=s.scrollTop;},
      getAiRanges:()=>view.current&&aiField.current?view.current.state.field(aiField.current):[],
      shouldFollow:(_start,end)=>{const v=view.current;if(!v)return false;const scroll=v.scrollDOM,rect=scroll.getBoundingClientRect(),at=v.coordsAtPos(Math.min(end,v.state.doc.length));return shouldAutoFollow({docLength:v.state.doc.length,end,scrollTop:scroll.scrollTop,scrollHeight:scroll.scrollHeight,clientHeight:scroll.clientHeight,rangeBottom:at?.bottom,viewportTop:rect.top,viewportBottom:rect.bottom});},
      reveal:(_start,end)=>{const v=view.current;if(!v)return;v.dispatch({effects:EditorView.scrollIntoView(Math.min(end,v.state.doc.length),{y:'end',yMargin:12})});},
      getValue: () => view.current?.state.doc.toString() ?? '',
      setValue: (text: string,ranges?:AiRange[]) => {
        if (!view.current) return;
        suppress.current = true;
        try{view.current.dispatch(revisionTransaction(view.current.state,text,ranges));}finally{suppress.current = false;}
      },
      edit:async(action)=>{
        const target=view.current;if(!target)return;
        if(action==='selectAll'){selectAll(target);target.focus();return;}
        const originalSelection=target.state.selection,selection=originalSelection.main,before=target.state.doc.toString();
        if(action!=='paste'&&selection.empty)throw new Error('请先在正文中选中文字。');
        if(action!=='copy'&&target.state.readOnly)throw new Error('正在保存 AI 修改，请稍后编辑。');
        if(!navigator.clipboard)throw new Error('浏览器不支持剪贴板按钮，请使用 Ctrl+C、Ctrl+X 或 Ctrl+V。');
        let insert='';
        try{if(action==='paste')insert=await navigator.clipboard.readText();
        else await navigator.clipboard.writeText(target.state.sliceDoc(selection.from,selection.to));}
        catch{throw new Error(action==='paste'?'浏览器未允许读取剪贴板，请回到正文按 Ctrl+V。':'浏览器未允许写入剪贴板，请回到正文使用 Ctrl+C 或 Ctrl+X。');}
        if(action==='copy'){target.focus();return;}
        if(view.current!==target||target.state.readOnly||target.state.doc.toString()!==before||!target.state.selection.eq(originalSelection))throw new Error('正文或选区已变化，未执行修改。请重试。');
        if(action==='paste'&&!insert)return;
        target.dispatch({changes:{from:selection.from,to:selection.to,insert},selection:{anchor:selection.from+insert.replace(/\r\n|\r/g,'\n').length},annotations:isolateHistory.of('full'),scrollIntoView:true});target.focus();
      },
      focus: () => view.current?.focus(),
      undo: () => {
        if (view.current&&!view.current.state.readOnly){undo(view.current);view.current.focus();}
      },
      redo: () => {
        if (view.current&&!view.current.state.readOnly){redo(view.current);view.current.focus();}
      },
      getSelection: () => {
        const target = view.current;
        if (!target) return { start: 0, end: 0 };
        const range = target.state.selection.main;
        return { start: range.from, end: range.to };
      },
      setSelection: (start: number, end: number) => {
        const target = view.current;
        if (!target) return;
        const length = target.state.doc.length;
        const from = Math.max(0, Math.min(start, length));
        const to = Math.max(from, Math.min(end, length));
        target.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
        target.focus();
      },
    }),
    [],
  );

  return <div className="editor-host" ref={host} />;
});

export default Editor;
