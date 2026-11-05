// Queues embed messages until the app takes the listener. A classic script
// so it runs before the deferred module. Keep this free of secrets.
(function () {
  var queue = [];
  window.__GEV_MESSAGE_QUEUE__ = queue;
  window.__GEV_QUEUE_MESSAGES__ = true;
  window.addEventListener('message', function (event) {
    if (!window.__GEV_QUEUE_MESSAGES__) return;
    var type = event && event.data && event.data.type;
    if (type === 'gev:config' || type === 'gev:visibility') queue.push(event);
  });
})();
