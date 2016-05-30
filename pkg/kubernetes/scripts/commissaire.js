/*
 * This file is part of Cockpit.
 *
 * Copyright (C) 2016 Red Hat, Inc.
 *
 * Cockpit is free software; you can redistribute it and/or modify it
 * under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation; either version 2.1 of the License, or
 * (at your option) any later version.
 *
 * Cockpit is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with Cockpit; If not, see <http://www.gnu.org/licenses/>.
 */

/*
 * This is basically throwaway code just to have a minimal example
 * of commissare integration. None of this is really the way we'd
 * want to do things if we can get commissare to store it's data
 * on kubernetes nodes as annotations.
 * There is also a fair bit of functionality missing to make the
 * designs a reality.
 */

(function() {
    "use strict";

    var COMMISSAIRE_NAMESPACE = "commissaire";
    var COMMISSAIRE_KIND = "Pod";
    var COMMISSAIRE_NAME = "commissaire";
    var DONE = "done";
    var RUNNING = "running";
    var PENDING = "pending";
    var FAILED = "failed";
    var API = "/api/v0/";

    function nodeExternalIP(node) {
        if (!node || !node.status)
            return;

        var addresses = node.status.addresses;
        var address;
        /* If no addresses then it hasn't even started */
        if (addresses) {
            addresses.forEach(function(a) {
                if (a.type == "LegacyHostIP" || address.type == "ExternalIP") {
                    address = a.address;
                    return false;
                }
            });
        }
        return address;
    }

    angular.module('kubernetes.commissaire', [
        "kubeClient.cockpit"
    ])

    .value("COMMISSAIRE_RUNNING", RUNNING)
    .value("COMMISSAIRE_PENDING", PENDING)
    .value("COMMISSAIRE_FAILED", FAILED)
    .value("COMMISSAIRE_DONE", DONE)

    .factory('Commissaire', [
        "$q",
        "$interval",
        "KubeRequest",
        "kubeSelect",
        "kubeLoader",
        "CockpitKubeRequest",
        function ($q, $interval, KubeRequest, select, loader, CockpitKubeRequest) {
            function Commissaire (baseUrl, clusterName, options) {
                var self = this;

                var seenAddresses = {};
                var pendingReqs = {};

                self.lastUpgradeStatus = null;
                self.numUpgraded = 0;

                var upgradeStatuses = {};

                var defaultRefresh = 300000;
                var activeRefresh = 5000;
                var currentRefresh;
                var upgradeInterval;

                function changeInterval(time) {
                    if (upgradeInterval)
                        $interval.cancel(upgradeInterval);
                    currentRefresh = time;
                    upgradeInterval = $interval(upgradeStatus, time);
                }

                function upgradeStatus() {
                    if (pendingReqs["upgrade"])
                        return;

                    var path = baseUrl + API + "cluster/" + clusterName + "/upgrade";
                    var req = KubeRequest("GET", path, null, options);
                    pendingReqs["upgrade"] = req;
                    req.then(function (data) {
                        var seen = {};
                        delete pendingReqs["upgrade"];
                        if (!data || !data.data) {
                            upgradeStatuses = {};
                            return;
                        }

                        var done = data.data.upgraded || [];
                        var running = data.data.in_process || [];
                        var i, addr;
                        for (i = 0; i < running.length; i++) {
                            addr = running[i];
                            if (data.data.status == 'in_process') {
                                if (i === 0)
                                    upgradeStatuses[addr] = RUNNING;
                                else
                                    upgradeStatuses[addr] = PENDING;
                            } else if (data.data.status == 'failed' && i === 0)
                                upgradeStatuses[addr] = FAILED;
                            seen[addr] = true;
                        }

                        for (i = 0; i < done.length; i++){
                            addr = done[i];
                            upgradeStatuses[addr] = DONE;
                            seen[addr] = true;
                        }

                        for (addr in upgradeStatuses) {
                            if (!seen[addr])
                                delete upgradeStatuses[addr];
                        }

                        self.lastUpgradeStatus = data.data.status;
                        self.numUpgraded = done.length;

                        if (data.data.status == "in_process") {
                            if (currentRefresh != activeRefresh)
                                changeInterval(activeRefresh);
                        } else if (currentRefresh != defaultRefresh) {
                            changeInterval(defaultRefresh);
                        }
                    })
                    .catch(function (ex) {
                        delete pendingReqs["upgrade"];
                        console.warn("Couldn't get status from Commissaire", ex);
                    });
                }

                function ensureNode(node) {
                    var addr = nodeExternalIP(node);
                    var path = baseUrl + API + "cluster/" + clusterName + "/hosts/" + addr;
                    if (addr && !seenAddresses[addr] && !pendingReqs[addr]) {
                        var req = KubeRequest("PUT", path, null, options);
                        pendingReqs[addr] = req;
                        req.then(function () {
                                seenAddresses[addr] = true;
                                delete pendingReqs[addr];
                            })
                            .catch(function () {
                                delete pendingReqs[addr];
                            });
                    }
                }

                var c = loader.listen(function() {
                    var node;
                    var nodes = select().kind("Node");
                    for (node in nodes)
                        ensureNode(nodes[node]);
                });
                loader.watch("Node");

                upgradeStatus();
                changeInterval(defaultRefresh);

                self.getUpgradeStatus = function (node) {
                    var addr = nodeExternalIP(node);
                    if (addr)
                        return upgradeStatuses[addr];
                };

                self.upgrade = function upgrade() {
                    var path = baseUrl + API + "cluster/" + clusterName + "/upgrade";
                    var data = { "upgrade_to" : "unused" };
                    var req = KubeRequest("PUT", path, data, options);
                    self.lastUpgradeStatus = "in_process";
                    return req.then(function () {
                            changeInterval(activeRefresh);
                        })
                        .catch(function (ex) {
                            console.warn("Failed to start upgrade", ex);
                            self.lastUpgradeStatus = "failed";
                        });
                };

                self.close = function close() {
                    var addr;
                    if (upgradeInterval)
                        $interval.cancel(upgradeInterval);
                    c.cancel();

                    for (addr in pendingReqs) {
                        var req = pendingReqs[addr];
                        if (req && req.cancel)
                            req.cancel();
                    }
                };
            }

            function getCommissaire(url, clusters, options) {
                var com_ins;
                if (!clusters || !clusters.length) {
                    return CockpitKubeRequest("PUT", url + "/default", null, options)
                            .then(function() {
                                com_ins = new Commissaire(url, "default", options);
                                return com_ins;
                            })
                            .catch(function (ex) {
                                console.warn("Failed to create first commissaire cluster", ex);
                                return $q.reject();
                            });
                } else {
                    com_ins = new Commissaire(url, clusters[0], options);
                    return com_ins;
                }
            }

            return {
                connectObject: function (kind, namespace, name) {
                    if (!kind)
                        kind = COMMISSAIRE_KIND;
                    if (!namespace)
                        namespace = COMMISSAIRE_NAMESPACE;
                    if (!name)
                        name = COMMISSAIRE_NAME;

                    var obj = select().kind(name).namespace(namespace).name(name);
                    if (!obj)
                        return $q.reject();

                    var url = obj.metadata.selfLink + "/proxy" + API + "clusters";
                    return KubeRequest("GET", url)
                        .then(function (data) {
                            return getCommissaire(url, data.data);
                        });
                },
                connectDirect: function (options) {
                    return CockpitKubeRequest("GET", API + "clusters", null, options)
                        .then(function (data) {
                            return getCommissaire("", data.data, options);
                        });
                },
            };
        }
    ]);

}());
