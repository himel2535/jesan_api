import 'reflect-metadata';
import { Expose, Type } from 'class-transformer';
import { describe, expect, it } from 'vitest';
import { serializeForAccess } from './serialize';
import { VisibleWith } from './visible-with';

class LineDto {
  @Expose() name!: string;
  @VisibleWith('product.cost.view') cost!: number;
  @VisibleWith('profit.view') margin!: number;
}

class ReportDto {
  @Expose() title!: string;
  @Expose() @Type(() => LineDto) lines!: LineDto[];
  @VisibleWith('profit.view') total!: number;
}

const source = {
  title: 'Stock',
  lines: [
    { name: 'OPC', cost: 570, margin: 30, secret: 'x' },
    { name: 'PCC', cost: 560, margin: 25, secret: 'x' },
  ],
  total: 5000,
  internal: 'x',
};

const serialize = (...permissions: string[]) =>
  serializeForAccess(ReportDto, source, new Set(permissions));

describe('serializeForAccess', () => {
  it('drops every field that is not declared, whoever asks', () => {
    const everything = serialize('product.cost.view', 'profit.view');
    expect(JSON.stringify(everything)).not.toContain('secret');
    expect(everything).not.toHaveProperty('internal');
  });

  it('sends only the open fields to a caller with no permissions', () => {
    expect(JSON.parse(JSON.stringify(serialize()))).toEqual({
      title: 'Stock',
      lines: [{ name: 'OPC' }, { name: 'PCC' }],
    });
  });

  it('sends exactly the fields the caller’s permissions unlock, also inside lists', () => {
    expect(JSON.parse(JSON.stringify(serialize('product.cost.view')))).toEqual({
      title: 'Stock',
      lines: [
        { name: 'OPC', cost: 570 },
        { name: 'PCC', cost: 560 },
      ],
    });
    expect(JSON.parse(JSON.stringify(serialize('profit.view')))).toEqual({
      title: 'Stock',
      lines: [
        { name: 'OPC', margin: 30 },
        { name: 'PCC', margin: 25 },
      ],
      total: 5000,
    });
  });

  it('does not let one field’s permission unlock another', () => {
    const body = JSON.parse(JSON.stringify(serialize('product.cost.view'))) as {
      total?: number;
      lines: { margin?: number }[];
    };
    expect(body.total).toBeUndefined();
    expect(body.lines[0]?.margin).toBeUndefined();
  });

  it('serializes a list of objects', () => {
    const result = serializeForAccess(LineDto, source.lines, new Set(['product.cost.view']));
    expect(JSON.parse(JSON.stringify(result))).toEqual([
      { name: 'OPC', cost: 570 },
      { name: 'PCC', cost: 560 },
    ]);
  });
});
