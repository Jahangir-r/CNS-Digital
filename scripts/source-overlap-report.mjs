#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const reference=process.argv[2],scope=(process.argv.find(value=>value.startsWith('--scope='))??'--scope=whole-tree').split('=')[1];
if(!reference||!['legacy-core','whole-tree'].includes(scope)){console.error('Usage: node scripts/source-overlap-report.mjs /path/to/reference-project [--scope=legacy-core|whole-tree]');process.exit(2);}
const roots=['src','public'],extensions=new Set(['.ts','.js','.html']);
const ignored=new Set(['node_modules','test','tests','images','assets','logs','backups','data','generated','.git']);
async function files(root){const out=[];async function visit(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true}).catch(()=>[])){if(ignored.has(entry.name))continue;const absolute=path.join(dir,entry.name);if(entry.isDirectory())await visit(absolute);else if(extensions.has(path.extname(entry.name)))out.push(absolute);}}for(const name of roots)await visit(path.join(root,name));return out;}
const legacyReference=new Set(['src/db.ts','src/auth.ts','src/server.ts','src/reports/normalization.ts','src/reports/service.ts','public/app.js']);
const legacyCurrent=file=>legacyReference.has(file)||file.startsWith('src/core/database/')||file.startsWith('src/modules/auth/')||file.startsWith('src/modules/authorization/')||file.startsWith('src/modules/journal/')||file.startsWith('public/js/');
function clean(source){return source.replace(/\/\*[\s\S]*?\*\//g,' ').replace(/(^|\s)\/\/.*$/gm,' ').replace(/^\s*(?:import|export\s+\{).*$/gm,' ').replace(/\s+/g,' ').trim();}
const boilerplate=new Set(['const','let','return','function','async','await','string','number','true','false','null','undefined','select','from','where','insert','update','delete','http','https','json','api']);
function lexical(source){return clean(source).toLowerCase().match(/[\p{L}_$][\p{L}\p{N}_$]*|\d+|=>|===|!==|[{}()[\].,:?]/gu)?.filter(token=>!boilerplate.has(token))??[];}
function structural(source){let text=clean(source).replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g,'STR').replace(/\b\d+(?:\.\d+)?\b/g,'NUM');const reserved=new Set(['if','else','for','while','switch','case','try','catch','throw','return','new','class','function','async','await','const','let','var','true','false','null']);return (text.match(/[A-Za-z_$][\w$]*|=>|===|!==|[{}()[\].,:?]/g)??[]).map(t=>reserved.has(t)?t:/^[A-Za-z_$]/.test(t)?'ID':t);}
function windows(tokens,size=18){const result=new Map();for(let i=0;i+size<=tokens.length;i++){const value=tokens.slice(i,i+size).join(' ');if(!result.has(value))result.set(value,i);}return result;}
function compare(current,old,mode){const a=windows(mode(current.text)),b=windows(mode(old.text));let matches=0;const samples=[];for(const [block,index] of a){const other=b.get(block);if(other===undefined)continue;matches++;if(samples.length<8)samples.push({current:`${current.relative}:${index+1}`,reference:`${old.relative}:${other+1}`,block});}return{matches,total:Math.max(1,a.size),samples};}
const currentRoot=process.cwd(),referenceRoot=path.resolve(reference);let currentFiles=await files(currentRoot),referenceFiles=await files(referenceRoot);
if(scope==='legacy-core'){currentFiles=currentFiles.filter(file=>legacyCurrent(path.relative(currentRoot,file)));referenceFiles=referenceFiles.filter(file=>legacyReference.has(path.relative(referenceRoot,file)));}
async function load(list,root){return Promise.all(list.map(async file=>({relative:path.relative(root,file),text:await fs.readFile(file,'utf8')})));}
const [current,old]=await Promise.all([load(currentFiles,currentRoot),load(referenceFiles,referenceRoot)]);
const pairs=[];for(const a of current)for(const b of old){const lexicalResult=compare(a,b,lexical),structuralResult=compare(a,b,structural);if(lexicalResult.matches||structuralResult.matches)pairs.push({current:a.relative,reference:b.relative,lexical:lexicalResult,structural:structuralResult});}
const totalLexical=current.reduce((n,f)=>n+windows(lexical(f.text)).size,0)||1,totalStructural=current.reduce((n,f)=>n+windows(structural(f.text)).size,0)||1;
const uniqueLexical=new Set(),uniqueStructural=new Set();for(const pair of pairs){for(const sample of pair.lexical.samples)uniqueLexical.add(`${pair.current}:${sample.current}`);for(const sample of pair.structural.samples)uniqueStructural.add(`${pair.current}:${sample.current}`);}
const exact=[];for(const a of current){const meaningful=clean(a.text);if(meaningful.length<120)continue;for(const b of old)if(meaningful===clean(b.text)){exact.push({current:a.relative,reference:b.relative,characters:meaningful.length});break;}}
const report={scope,reference:referenceRoot,files:{current:current.length,reference:old.length},metrics:{exact_meaningful_file_overlap_percent:+(100*exact.length/Math.max(1,current.length)).toFixed(3),normalized_lexical_overlap_percent:+(100*uniqueLexical.size/totalLexical).toFixed(3),normalized_structural_overlap_percent:+(100*uniqueStructural.size/totalStructural).toFixed(3)},exact,pairs:pairs.sort((a,b)=>b.lexical.matches-a.lexical.matches).slice(0,25)};
console.log(JSON.stringify(report,null,2));
if(Math.max(...Object.values(report.metrics))>=1)process.exitCode=1;
