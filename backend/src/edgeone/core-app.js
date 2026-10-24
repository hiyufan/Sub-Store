import 'fastestsmallesttextencoderdecoder';
import { OpenAPI } from '@/vendor/open-api';
// Injected by build-edgeone.cjs; this is local to one factory invocation.
import { state } from 'sub-store:edgeone-context';

export default new OpenAPI('sub-store', false, { storage: state });
