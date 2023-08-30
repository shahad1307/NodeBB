"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
// plugins.d.ts
const db = require('../database');
const topics = require('../topics');
const plugins = require('../plugins');
const meta = require('../meta');
const privileges = require('../privileges');
const user = require('../user');
module.exports = function (Categories) {
    function filterScheduledTids(tids) {
        return __awaiter(this, void 0, void 0, function* () {
            const scores = yield db.sortedSetScores('topics:scheduled', tids);
            const now = Date.now();
            return tids.filter((tid, index) => tid && (!scores[index] || scores[index] <= now));
        });
    }
    Categories.getCategoryTopics = function (data) {
        return __awaiter(this, void 0, void 0, function* () {
            let results = yield plugins.hooks.fire('filter:category.topics.prepare', data);
            const tids = yield Categories.getTopicIds(results);
            let topicsData = yield topics.getTopicsByTids(tids, data.uid);
            topicsData = yield user.blocks.filter(data.uid, topicsData);
            if (!topicsData.length) {
                return { topics: [], uid: data.uid };
            }
            topics.calculateTopicIndices(topicsData, data.start);
            results = yield plugins.hooks.fire('filter:category.topics.get', {
                cid: data.cid,
                topics: topicsData,
                uid: data.uid,
            });
            return { topics: results.topics, nextStart: data.stop + 1 };
        });
    };
    Categories.getTopicIds = function (data) {
        return __awaiter(this, void 0, void 0, function* () {
            const dataForPinned = Object.assign({}, data);
            dataForPinned.start = 0;
            dataForPinned.stop = -1;
            const [pinnedTids, set, direction] = yield Promise.all([
                Categories.getPinnedTids(dataForPinned),
                Categories.buildTopicsSortedSet(data),
                Categories.getSortedSetRangeDirection(data.sort),
            ]);
            const totalPinnedCount = pinnedTids.length;
            const pinnedTidsOnPage = pinnedTids.slice(data.start, data.stop !== -1 ? data.stop + 1 : undefined);
            const pinnedCountOnPage = pinnedTidsOnPage.length;
            const topicsPerPage = data.stop - data.start + 1;
            const normalTidsToGet = Math.max(0, topicsPerPage - pinnedCountOnPage);
            if (!normalTidsToGet && data.stop !== -1) {
                return pinnedTidsOnPage;
            }
            if (plugins.hooks.hasListeners('filter:categories.getTopicIds')) {
                const result = yield plugins.hooks.fire('filter:categories.getTopicIds', {
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
            let normalTids;
            const reverse = direction === 'highest-to-lowest';
            if (Array.isArray(set)) {
                const weights = set.map((s, index) => (index ? 0 : 1));
                normalTids = yield db[reverse ? 'getSortedSetRevIntersect' : 'getSortedSetIntersect']({ sets: set, start: start, stop: stop, weights: weights });
            }
            else {
                normalTids = yield db[reverse ? 'getSortedSetRevRange' : 'getSortedSetRange'](set, start, stop);
            }
            normalTids = normalTids.filter(tid => pinnedTids.indexOf(tid) === -1);
            return pinnedTidsOnPage.concat(normalTids);
        });
    };
    Categories.getTopicCount = function (data) {
        return __awaiter(this, void 0, void 0, function* () {
            if (plugins.hooks.hasListeners('filter:categories.getTopicCount')) {
                const result = yield plugins.hooks.fire('filter:categories.getTopicCount', {
                    topicCount: data.category.topic_count,
                    data: data,
                });
                return result && result.topicCount;
            }
            const set = yield Categories.buildTopicsSortedSet(data);
            if (Array.isArray(set)) {
                return yield db.sortedSetIntersectCard(set);
            }
            else if (data.targetUid && set) {
                return yield db.sortedSetCard(set);
            }
            return data.category.topic_count;
        });
    };
    Categories.buildTopicsSortedSet = function (data) {
        return __awaiter(this, void 0, void 0, function* () {
            const { cid } = data;
            let set = `cid:${cid}:tids`;
            const sort = data.sort ||
                (data.settings && data.settings.categoryTopicSort) ||
                meta.config.categoryTopicSort ||
                'newest_to_oldest';
            if (sort === 'most_posts') {
                set = `cid:${cid}:tids:posts`;
            }
            else if (sort === 'most_votes') {
                set = `cid:${cid}:tids:votes`;
            }
            else if (sort === 'most_views') {
                set = `cid:${cid}:tids:views`;
            }
            if (data.tag) {
                if (Array.isArray(data.tag)) {
                    set = [set].concat(data.tag.map(tag => `tag:${tag}:topics`));
                }
                else {
                    set = [set, `tag:${data.tag}:topics`];
                }
            }
            if (data.targetUid) {
                set = (Array.isArray(set) ? set : [set]).concat([
                    `cid:${cid}:uid:${data.targetUid}:tids`,
                ]);
            }
            const result = yield plugins.hooks.fire('filter:categories.buildTopicsSortedSet', {
                set: set,
                data: data,
            });
            return result && result.set;
        });
    };
    Categories.getSortedSetRangeDirection = function (sort) {
        return __awaiter(this, void 0, void 0, function* () {
            sort = sort || 'newest_to_oldest';
            const directionOptions = [
                'newest_to_oldest',
                'most_posts',
                'most_votes',
                'most_views',
            ];
            const direction = directionOptions.indexOf(sort) !== -1 ?
                'highest-to-lowest' :
                'lowest-to-highest';
            const result = yield plugins.hooks.fire('filter:categories.getSortedSetRangeDirection', {
                sort: sort,
                direction: direction,
            });
            return result && result.direction;
        });
    };
    Categories.getAllTopicIds = function (cid, start, stop) {
        return __awaiter(this, void 0, void 0, function* () {
            return yield db.getSortedSetRange([`cid:${cid}:tids:pinned`, `cid:${cid}:tids`], start, stop);
        });
    };
    Categories.getPinnedTids = function (data) {
        return __awaiter(this, void 0, void 0, function* () {
            if (plugins.hooks.hasListeners('filter:categories.getPinnedTids')) {
                const result = yield plugins.hooks.fire('filter:categories.getPinnedTids', {
                    pinnedTids: [],
                    data: data,
                });
                return result && result.pinnedTids;
            }
            const [allPinnedTids, canSchedule] = yield Promise.all([
                db.getSortedSetRevRange(`cid:${data.cid}:tids:pinned`, data.start, data.stop),
                privileges.categories.can('topics:schedule', data.cid, data.uid),
            ]);
            const pinnedTids = canSchedule ?
                allPinnedTids :
                yield filterScheduledTids(allPinnedTids);
            return yield topics.tools.checkPinExpiry(pinnedTids);
        });
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
    Categories.onNewPostMade = function (cid, pinned, postData) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!cid || !postData) {
                return;
            }
            const promises = [
                db.sortedSetAdd(`cid:${cid}:pids`, postData.timestamp, postData.pid),
                db.incrObjectField(`category:${cid}`, 'post_count'),
            ];
            if (!pinned) {
                promises.push(db.sortedSetIncrBy(`cid:${cid}:tids:posts`, 1, postData.tid));
            }
            yield Promise.all(promises);
            yield Categories.updateRecentTidForCid(cid);
        });
    };
};
