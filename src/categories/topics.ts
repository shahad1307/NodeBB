

declare function require(name: string);
// plugins.d.ts

const db = require('../database') as unknown as DB;
const topics = require('../topics') as unknown as Topics;
const plugins = require('../plugins') as unknown as Plugins;
const meta = require('../meta') as unknown as Meta;
const privileges = require('../privileges') as unknown as Privileges;
const user = require('../user') as unknown as User;

interface DB {
  sortedSetIntersectCard: (a: string | string[]) => Promise<number>;
  sortedSetCard: (set: string | string[]) => Promise<number>;
  getSortedSetRange: (
    a: string[] | string,
    b: number,
    c: number
  ) => Promise<number[]>;
  getSortedSetRevRange: (a: string, b: number, c: number) => Promise<number[]>;
  sortedSetAdd: (a: string, b: number, c: number) => Promise<number[]>;
  sortedSetIncrBy: (a: string, b: number, c: number) => Promise<number[]>;
  incrObjectField: (a: string, b: string) => Promise<number[]>;
  sortedSetScores: (a: string, b: number[]) => Promise<number[]>;
  getSortedSetRevIntersect: (obj: {
    sets: string[];
    start: number;
    stop: number;
    weights: (1 | 0)[];
  }) => Promise<number[]>;
  getSortedSetIntersect: (obj: {
    sets: string[];
    start: number;
    weights: (1 | 0)[];
  }) => Promise<number[]>;
}

interface Meta {
  config: {
    categoryTopicSort: string;
  };
}

interface User {
  blocks: {
    filter: (a: number, b: TopicsData[]) => Promise<TopicsData[]>;
  };
}

interface Privileges {
  categories: {
    can: (a: string, b: number, c: number) => Promise<boolean>;
  };
}

interface Topics {
  tid: number;
  title: string;
  tools: {
    checkPinExpiry: (a: number[]) => Promise<number[]>;
  };
  getTopicsByTids: (a: number[], b: number) => Promise<TopicsData[]>;
  calculateTopicIndices: (a: TopicsData[], b: number) => void;
}
interface Plugins {
  hooks: {
    fire: (hookName: string, data: CategoryData) => Promise<CategoryData>;
    hasListeners: (a: string) => boolean;
  };
}
interface CategoryData {
  cid?: number;
  uid?: number;
  start?: number;
  stop?: number;
  sort?: string;
  tag?: string | string[];
  settings?: { categoryTopicSort: string };
  category?: { topic_count: number };
  targetUid?: number;
  topics?: TopicsData[];
  set?: string[] | string;
  topicCount?: number;
  data?: CategoryData;
  pinnedTids?: number[];
  direction?: 'highest-to-lowest' | 'lowest-to-highest';
  tids?: number[];
  allPinnedTids?: number[];
  totalPinnedCount?: number;
  normalTidsToGet?: number;
}

interface TopicsData {
  tid: number;
  scheduled: boolean;
  deleted: boolean;
  isOwner: boolean;
  title: string;
  titleRaw?: string;
  slug: number;
  teaser: string | null;
  noAnchor: boolean;
  tags: string[];
}

interface PostData {
  timestamp: number;
  pid: number;
  tid: number;
}

interface privilegesData {
  view_deleted: boolean;
}

interface getCategoryTopicsResponse {
  topics: TopicsData[];
  nextStart?: number;
  uuid?: number;
}

export = function (Categories: {
  getPinnedTids: (data: CategoryData) => Promise<number[]>;
  buildTopicsSortedSet: (data: CategoryData) => Promise<string | string[]>;
  getSortedSetRangeDirection: (sort: string) => Promise<string>;
  getCategoryTopics: (data: CategoryData) => Promise<getCategoryTopicsResponse>;
  getTopicIds: (data: CategoryData) => Promise<number[]>;
  getTopicCount: (data: CategoryData) => Promise<number>;
  getAllTopicIds: (
    cid: number,
    start: number,
    stop: number
  ) => Promise<number[]>;
  modifyTopicsByPrivilege: (
    topics: TopicsData[],
    privileges: privilegesData
  ) => void;
  onNewPostMade: (
    cid: number,
    pinned: boolean,
    postData: PostData
  ) => Promise<void>;
  updateRecentTidForCid: (cid: number) => Promise<void>;
}) {
    async function filterScheduledTids(tids: number[]): Promise<number[]> {
        const scores = await db.sortedSetScores('topics:scheduled', tids);
        const now = Date.now();
        return tids.filter(
            (tid, index) => tid && (!scores[index] || scores[index] <= now)
        );
    }
    Categories.getCategoryTopics = async function (data) {
        let results = await plugins.hooks.fire(
            'filter:category.topics.prepare',
            data
        );
        const tids = await Categories.getTopicIds(results);
        let topicsData = await topics.getTopicsByTids(tids, data.uid);
        topicsData = await user.blocks.filter(data.uid, topicsData);

        if (!topicsData.length) {
            return { topics: [], uid: data.uid };
        }
        topics.calculateTopicIndices(topicsData, data.start);

        results = await plugins.hooks.fire('filter:category.topics.get', {
            cid: data.cid,
            topics: topicsData,
            uid: data.uid,
        });
        return { topics: results.topics, nextStart: data.stop + 1 };
    };

    Categories.getTopicIds = async function (data) {
        const dataForPinned = { ...data };
        dataForPinned.start = 0;
        dataForPinned.stop = -1;

        const [pinnedTids, set, direction] = await Promise.all([
            Categories.getPinnedTids(dataForPinned),
            Categories.buildTopicsSortedSet(data),
            Categories.getSortedSetRangeDirection(data.sort),
        ]);

        const totalPinnedCount = pinnedTids.length;
        const pinnedTidsOnPage = pinnedTids.slice(
            data.start,
            data.stop !== -1 ? data.stop + 1 : undefined
        );
        const pinnedCountOnPage = pinnedTidsOnPage.length;
        const topicsPerPage = data.stop - data.start + 1;
        const normalTidsToGet = Math.max(0, topicsPerPage - pinnedCountOnPage);

        if (!normalTidsToGet && data.stop !== -1) {
            return pinnedTidsOnPage;
        }

        if (plugins.hooks.hasListeners('filter:categories.getTopicIds')) {
            const result = await plugins.hooks.fire('filter:categories.getTopicIds', {
                tids: [],
                data: data,
                pinnedTids: pinnedTidsOnPage,
                allPinnedTids: pinnedTids,
                totalPinnedCount: totalPinnedCount,
                normalTidsToGet: normalTidsToGet,
            });
            return result && result.tids;
        }

        let { start } = data;
        if (start > 0 && totalPinnedCount) {
            start -= totalPinnedCount - pinnedCountOnPage;
        }

        const stop = data.stop === -1 ? data.stop : start + normalTidsToGet - 1;
        let normalTids: number[] | undefined;
        const reverse = direction === 'highest-to-lowest';
        if (Array.isArray(set)) {
            const weights = set.map((s, index) => (index ? 0 : 1));
            normalTids = await db[
                reverse ? 'getSortedSetRevIntersect' : 'getSortedSetIntersect'
            ]({ sets: set, start: start, stop: stop, weights: weights });
        } else {
            normalTids = await db[
                reverse ? 'getSortedSetRevRange' : 'getSortedSetRange'
            ](set, start, stop);
        }
        normalTids = normalTids.filter(tid => pinnedTids.indexOf(tid) === -1);
        return pinnedTidsOnPage.concat(normalTids);
    };

    Categories.getTopicCount = async function (data) {
        if (plugins.hooks.hasListeners('filter:categories.getTopicCount')) {
            const result = await plugins.hooks.fire(
                'filter:categories.getTopicCount',
                {
                    topicCount: data.category.topic_count,
                    data: data,
                }
            );
            return result && result.topicCount;
        }
        const set = await Categories.buildTopicsSortedSet(data);
        if (Array.isArray(set)) {
            return await db.sortedSetIntersectCard(set);
        } else if (data.targetUid && set) {
            return await db.sortedSetCard(set);
        }
        return data.category.topic_count;
    };

    Categories.buildTopicsSortedSet = async function (data) {
        const { cid } = data;
        let set: string[] | string = `cid:${cid}:tids`;
        const sort =
      data.sort ||
      (data.settings && data.settings.categoryTopicSort) ||
      meta.config.categoryTopicSort ||
      'newest_to_oldest';

        if (sort === 'most_posts') {
            set = `cid:${cid}:tids:posts`;
        } else if (sort === 'most_votes') {
            set = `cid:${cid}:tids:votes`;
        } else if (sort === 'most_views') {
            set = `cid:${cid}:tids:views`;
        }

        if (data.tag) {
            if (Array.isArray(data.tag)) {
                set = [set].concat(data.tag.map(tag => `tag:${tag}:topics`));
            } else {
                set = [set, `tag:${data.tag}:topics`];
            }
        }

        if (data.targetUid) {
            set = (Array.isArray(set) ? set : [set]).concat([
                `cid:${cid}:uid:${data.targetUid}:tids`,
            ]);
        }

        const result = await plugins.hooks.fire(
            'filter:categories.buildTopicsSortedSet',
            {
                set: set,
                data: data,
            }
        );
        return result && result.set;
    };

    Categories.getSortedSetRangeDirection = async function (sort) {
        sort = sort || 'newest_to_oldest';
        const directionOptions = [
            'newest_to_oldest',
            'most_posts',
            'most_votes',
            'most_views',
        ];
        const direction =
      directionOptions.indexOf(sort) !== -1 ?
          'highest-to-lowest' :
          'lowest-to-highest';
        const result = await plugins.hooks.fire(
            'filter:categories.getSortedSetRangeDirection',
            {
                sort: sort,
                direction: direction,
            }
        );
        return result && result.direction;
    };

    Categories.getAllTopicIds = async function (cid, start, stop) {
        return await db.getSortedSetRange(
            [`cid:${cid}:tids:pinned`, `cid:${cid}:tids`],
            start,
            stop
        );
    };

    Categories.getPinnedTids = async function (data) {
        if (plugins.hooks.hasListeners('filter:categories.getPinnedTids')) {
            const result = await plugins.hooks.fire(
                'filter:categories.getPinnedTids',
                {
                    pinnedTids: [],
                    data: data,
                }
            );
            return result && result.pinnedTids;
        }
        const [allPinnedTids, canSchedule] = await Promise.all([
            db.getSortedSetRevRange(
                `cid:${data.cid}:tids:pinned`,
                data.start,
                data.stop
            ),
            privileges.categories.can('topics:schedule', data.cid, data.uid),
        ]);
        const pinnedTids = canSchedule ?
            allPinnedTids :
            await filterScheduledTids(allPinnedTids);

        return await topics.tools.checkPinExpiry(pinnedTids);
    };

    Categories.modifyTopicsByPrivilege = function (topics, privileges) {
        if (!Array.isArray(topics) || !topics.length || privileges.view_deleted) {
            return;
        }

        topics.forEach((topic) => {
            if (!topic.scheduled && topic.deleted && !topic.isOwner) {
                topic.title = '[[topic:topic_is_deleted]]';
                if (topic.hasOwnProperty('titleRaw')) {
                    topic.titleRaw = '[[topic:topic_is_deleted]]';
                }
                topic.slug = topic.tid;
                topic.teaser = null;
                topic.noAnchor = true;
                topic.tags = [];
            }
        });
    };

    Categories.onNewPostMade = async function (cid, pinned, postData) {
        if (!cid || !postData) {
            return;
        }
        const promises = [
            db.sortedSetAdd(`cid:${cid}:pids`, postData.timestamp, postData.pid),
            db.incrObjectField(`category:${cid}`, 'post_count'),
        ];
        if (!pinned) {
            promises.push(
                db.sortedSetIncrBy(`cid:${cid}:tids:posts`, 1, postData.tid)
            );
        }
        await Promise.all(promises);
        await Categories.updateRecentTidForCid(cid);
    };
};
