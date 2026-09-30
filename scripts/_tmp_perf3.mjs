import { readFileSync, writeFileSync } from 'node:fs';
const cats = { c1: 'lease', c2: 'subscription', c3: 'service', c4: 'rental', c5: 'service', l1: 'lease' };
const edit = (s, ids) => {
  const f = `eval/contracts/${s}/recorded/extract-perfect.json`;
  const raw = readFileSync(f, 'utf8');
  const j = JSON.parse(raw);
  for (const id of ids) {
    const fields = j[id].fields;
    const at = fields.agreementType?.[0];
    if (!at) throw new Error(`${s} ${id}: no agreementType`);
    fields.agreementCategory = [{ value: cats[id], quote: at.quote, file: at.file, page: at.page, ...(at.clause ? { clause: at.clause } : {}) }];
    const fee = fields.fee ?? [];
    if (id === 'c2' || id === 'l1') { fee[0].value = { ...fee[0].value, what: id === 'c2' ? 'subscription fee' : 'rent' }; }
    if (id === 'c3') fee[0].value = { ...fee[0].value, what: 'monthly fee', vat: 'not_stated' };
    if (id === 'c4') {
      fee[0].value = { ...fee[0].value, what: 'rental' };
      const q = 'Mono R0.19 · colour R1.45 per copy';
      const base = { quote: q, file: 'c4-copier.pdf', page: 1, clause: 'Schedule item 8' };
      fee.push({ value: { cents: 19, per: 'copy', vat: 'not_stated', what: 'mono copy charge' }, ...base }, { value: { cents: 145, per: 'copy', vat: 'not_stated', what: 'colour copy charge' }, ...base });
    }
    if (id === 'c5') {
      const row = (t, what, cents, per) => ({ value: { cents, per, vat: 'excluded', what }, quote: t, file: 'c5-courier.pdf', page: 3, clause: 'Sch. A' });
      fields.fee = [
        row('Same-day, within city\tR185.00', 'Same-day, within city', 18500, 'consignment'),
        row('Overnight, national\tR240.00', 'Overnight, national', 24000, 'consignment'),
        row('Economy, 2–3 days, national\tR145.00', 'Economy, 2–3 days, national', 14500, 'consignment'),
        row('Per kg over 5 kg\tR18.00', 'Per kg over 5 kg', 1800, 'kg'),
        row('Outlying areas surcharge, per consignment\tR95.00', 'Outlying areas surcharge', 9500, 'consignment'),
        row('After-hours collection\tR220.00', 'After-hours collection', 22000, 'collection'),
        row('Waiting time, per 15 minutes after the first 15\tR60.00', 'Waiting time', 6000, '15 minutes'),
        { value: { text: '1.5% of declared value', what: 'insurance levy' }, quote: 'Insurance levy, declared value\t1.5%', file: 'c5-courier.pdf', page: 3, clause: 'Sch. A' },
      ];
    } else fields.fee = fee;
  }
  const out = JSON.stringify(j, null, 2) + '\n';
  writeFileSync(f, raw.includes('\r\n') ? out.replace(/\n/g, '\r\n') : out);
};
edit('demo-marula', ['c1', 'c2', 'c3', 'c4', 'c5']);
edit('watermark-marula', ['c1', 'c2', 'c3', 'c4', 'c5']);
edit('layout-lakeside', ['l1']);
console.log('ok');
