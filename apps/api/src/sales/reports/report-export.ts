import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import type { Report, ReportColumn } from './reports.service';

const fmt = (c: ReportColumn, v: unknown): string => {
  if (v === null || v === undefined || v === '') return '';
  if (c.type === 'money') return Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (c.type === 'percent') return `${Number(v).toFixed(1)}%`;
  if (c.type === 'number') return Number(v).toLocaleString('en-US', { maximumFractionDigits: 4 });
  return String(v);
};

/** Excel: numbers stay numeric so finance can pivot them; header, filters and totals row included. */
export async function reportToXlsx(r: Report): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CKH ONE';
  wb.created = new Date(r.generatedAt);
  const ws = wb.addWorksheet(r.title.slice(0, 31));
  ws.addRow([r.title]).font = { bold: true, size: 14 };
  ws.addRow([`Period ${r.filters.from} to ${r.filters.to}`, '', `Currency ${r.currency}`, '', `Generated ${r.generatedAt}`]);
  ws.addRow([]);
  const header = ws.addRow(r.columns.map((c) => c.label));
  header.font = { bold: true };
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF5' } };
    cell.border = { bottom: { style: 'thin' } };
  });
  for (const row of r.rows) {
    ws.addRow(r.columns.map((c) => (c.type === 'text' || c.type === 'date' ? (row[c.key] ?? '') : row[c.key] === null || row[c.key] === undefined ? null : Number(row[c.key]))));
  }
  if (r.totals) {
    const t = ws.addRow(r.columns.map((c, i) => (i === 0 ? 'Total' : r.totals![c.key] !== undefined ? Number(r.totals![c.key]) : null)));
    t.font = { bold: true };
    t.eachCell((cell) => (cell.border = { top: { style: 'thin' } }));
  }
  r.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = Math.max(12, Math.min(40, c.label.length + 4));
    if (c.type === 'money') col.numFmt = '#,##0.00';
    if (c.type === 'percent') col.numFmt = '0.0"%"';
  });
  ws.views = [{ state: 'frozen', ySplit: 4 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** PDF: landscape A4 table with repeated header on each page. */
export function reportToPdf(r: Report): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, info: { Title: r.title, Producer: 'CKH ONE' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const weights = r.columns.map((c) => (c.type === 'text' ? 2 : 1));
    const unit = width / weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((w) => w * unit);
    const size = r.columns.length > 9 ? 7 : 8;

    doc.fontSize(14).font('Helvetica-Bold').text(r.title);
    doc.fontSize(9).font('Helvetica').fillColor('#555').text(`Period ${r.filters.from} to ${r.filters.to} · Currency ${r.currency} · Generated ${r.generatedAt.slice(0, 16).replace('T', ' ')} UTC`);
    doc.moveDown(0.8).fillColor('#000');

    const drawRow = (cells: string[], bold = false, shade = false) => {
      const h = size + 8;
      if (doc.y + h > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        drawRow(r.columns.map((c) => c.label), true, true);
      }
      const y = doc.y;
      if (shade) doc.rect(left, y, width, h).fill('#e8eef5').fillColor('#000');
      let x = left;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
      cells.forEach((cell, i) => {
        const align = r.columns[i].type === 'text' ? 'left' : 'right';
        doc.text(cell, x + 3, y + 4, { width: widths[i] - 6, align, lineBreak: false, ellipsis: true });
        x += widths[i];
      });
      doc.y = y + h;
      doc.x = left;
    };

    drawRow(r.columns.map((c) => c.label), true, true);
    if (!r.rows.length) doc.font('Helvetica-Oblique').fontSize(9).text('No data for this period.', left, doc.y + 6);
    for (const row of r.rows) drawRow(r.columns.map((c) => fmt(c, row[c.key])));
    if (r.totals && r.rows.length) {
      doc.moveTo(left, doc.y).lineTo(left + width, doc.y).stroke();
      drawRow(r.columns.map((c, i) => (i === 0 ? 'Total' : r.totals![c.key] !== undefined ? fmt(c, r.totals![c.key]) : '')), true);
    }
    doc.end();
  });
}
