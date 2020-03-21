import { Field } from '../../models';
import { Operator, QueryBody } from '../../search-engine/query';
import { TextQueryBuilder } from '../../search-engine/query/builder';
import { SegmentConverter } from '../segment-converter';
import { SelectorSegmentConverterBase } from './selector-segment-converter-base';

const FIELD = Field.Channel;
const SELECTOR_REGEX = /^(?:c(?:h(?:a(?:n(?:n(?:e(?:l)?)?)?)?)?)?|s(?:e(?:n(?:d(?:e(?:r)?)?)?)?)?|!)$/u;

export class ChannelSegmentConverter extends SelectorSegmentConverterBase implements SegmentConverter {
  constructor() {
    super(FIELD, SELECTOR_REGEX);
  }

  // eslint-disable-next-line class-methods-use-this
  protected textToQuery(text: string): QueryBody {
    const builder = new TextQueryBuilder();

    const query = builder
      .fields(FIELD)
      .text(text)
      .operator(Operator.And)
      .build();

    return query;
  }
}
