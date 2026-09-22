import ExcelJS from 'exceljs';
import type {Version} from './templates.js';
export function templateWorkbook(version:Version, reference?:unknown) {
  const book=new ExcelJS.Workbook();book.creator='CNS Digital';book.title=`CNS Digital — Checklist template v${version.version_label}`;
  const sheet=book.addWorksheet('Şablon strukturu');
  sheet.addRow(['Versiya','Mövqe','Mövqə sırası','Bənd','Bənd sırası','Texnoloji kart','Məcburi','Aktiv','Avadanlıq','Xidmət','Obyekt','Mövqə açarı','Bənd açarı','Mövqə aktivdir']);
  for(const s of version.sections) for(const i of s.items) sheet.addRow([version.version_label,s.name,s.sort_order,i.name,i.sort_order,i.technology_card,!!i.required,!!i.active,i.equipment_name,s.service_name,s.object_name,s.stable_key,i.stable_key,!!s.active]);
  sheet.views=[{state:'frozen',ySplit:1}];sheet.autoFilter={from:'A1',to:'N'+Math.max(1,sheet.rowCount)};
  sheet.columns.forEach((c,index)=>c.width=[1,3,7].includes(index)?40:22);
  sheet.getRow(1).font={bold:true};sheet.eachRow(row=>row.alignment={vertical:'top',wrapText:true});
  const info=book.addWorksheet('Məlumat');info.addRows([['Şablon ID',version.template_id],['Versiya ID',version.id],['Versiya',version.version_label],['Status',version.status],['Revision',version.revision],['Content hash',version.content_hash??''],['Mövqələr',version.sections.length],['Bəndlər',version.sections.reduce((n,s)=>n+s.items.length,0)]]);
  info.columns=[{width:25},{width:60}];
  if(reference){const ref=book.addWorksheet('Təsdiq gözləyən qeydlər');ref.addRow(['Mənbə məlumatı; jurnal sahələrinə avtomatik tətbiq edilmir']);ref.addRow([JSON.stringify(reference,null,2)]);ref.getColumn(1).width=100;ref.getCell('A2').alignment={wrapText:true};}
  return book;
}
