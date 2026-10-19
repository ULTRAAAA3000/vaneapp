const { version: platformVersion } = require('zapier-platform-core');
const authentication = require('./authentication');
const { addKey, handleErrors } = require('./lib');
const channels = require('./triggers/channels');
const newPublishedPost = require('./triggers/new_published_post');
const postFailed = require('./triggers/post_failed');
const createPost = require('./creates/create_post');

module.exports = {
  version: require('./package.json').version,
  platformVersion,
  authentication,
  beforeRequest: [addKey],
  afterResponse: [handleErrors],
  triggers: {
    [newPublishedPost.key]: newPublishedPost,
    [postFailed.key]: postFailed,
    [channels.key]: channels,
  },
  creates: { [createPost.key]: createPost },
};
