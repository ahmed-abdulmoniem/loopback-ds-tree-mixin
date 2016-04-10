var _ = require('lodash'),
    Promise = require('bluebird');

function Tree(Model, config) {
    var _this = this;
    var DS = Model.getDataSource();
    _this.toObjectID = DS.ObjectID || null;

    Model.defineProperty('ancestors', {type: [{type: Object}], required: true});
    Model.defineProperty('parent', {type: "object", required: false});
    Model.defineProperty('children', {type: [{type: Object}], required: false});
    Model.defineProperty('depth', {type: Number, required: false});
    Model.defineProperty('orderBy', {type: Number, required: false});

    /**
     * Create a tree from the database table
     * @param {object} parent
     * @param {object} options
     * @param {function} callback
     * @returns {*}
     */
    Model.asTree = function (parent, options, callback) {
        if (arguments.length == 3 && typeof arguments[1] == 'object') {
            callback = arguments[2];
        } else if (arguments.length == 3) {
            callback = arguments[2];
            options = arguments[1] = {};
        } else if (arguments.length == 2 && typeof arguments[1] == 'function') {
            callback = arguments[1];
        } else if (arguments.length == 1 || arguments.length == 0) {
            options = {};
        }

        locateNodeWithCallback(parent, function (err, Parent) {
            if(err) return callback(err);
            Model.find({where: {ancestors: Parent.id}, order: 'orderBy ASC'}, function (err, docs) {
                if(err) return callback(err);
                var tree = toTree(docs, options);

                if (options.withParent) {
                    Parent.children = tree;
                    if (typeof callback == 'function') {
                        return callback(null, {result: tree});
                    }

                    return Parent;
                }

                if (typeof callback == 'function') {
                    return callback(null, {result: tree});
                }
                return tree;
            });
        });
    };

    Model.addNode = function (parent, node, callback) {

        return locateNode(parent)
            .then(function (Parent) {
                return create(node, Parent).then(function (res) {
                    if (typeof callback == 'function') {
                        callback(null, res);
                    }

                    return res;
                });
            });
    };

    Model.moveNode = function (node, newParent, callback) {
        /*
         * 1. locate the node
         * 2. locate the parent
         * 3. attach node to the parent
         * 4. re-arrange the ancestors for the node's children
         * */
        if (arguments.length == 3 && typeof arguments[1] == 'object') {
            callback = arguments[2];
        } else if (arguments.length == 3) {
            callback = arguments[2];
            options = arguments[1] = {};
        } else if (arguments.length == 2) {
            callback = arguments[1];
        }
        var tasks = {
            child: locateNode(node),
            parent: locateNode(newParent)
        };

        return Promise.props(tasks)
            .then(function (results) {
                results.child.parent = results.parent.id;
                results.child.ancestors = results.parent.ancestors;
                results.child.ancestors.push(results.parent.id);
                return results;
            })
            .then(function (results) {
                //find the children
                return Model.find({where: {ancestors: results.child.id}})
                    .then(function (children) {
                        if (children.length == 0) {
                            return results;
                        }

                        var tasks = [];
                        _.forEach(children, function (child) {
                            child.ancestors = results.child.ancestors;
                            child.ancestors.push(results.child.id);
                            tasks.push(child.save());
                        });

                        return Promise.all(tasks)
                            .then(function () {
                                return results;
                            });
                    });
            })
            .then(function (results) {
                return results.child.save();
            });
    };

    Model.deleteNode = function (node, options, callback) {
        if (arguments.length == 3 && typeof arguments[1] == 'object') {
            callback = arguments[2];
        } else if (arguments.length == 3) {
            callback = arguments[2];
            options = arguments[1] = {};
        } else if (arguments.length == 2) {
            callback = arguments[1];
        }
        /*
         Things to consider :
         1. Before deleting the node, we need to orphan any children it might have
         2. If the option deleteWithChildren is provided then delete everything
         */

        return locateNode(node)
            .then(function (nodeToDelete) {
                var myId = nodeToDelete.id;
                //find all children that belong to this node
                return Model.find({where: {ancestors: myId}})
                    .then(orphanChildren)
                    .then(deleteNode.bind(null, myId))
                    .then(function () {
                        if (typeof callback == 'function') {
                            callback(null, true);
                        }

                        return true;
                    })
            })
            .catch(function (err) {
                if (typeof callback == 'function') {
                    callback(err);
                }

                return false;
            });

        function orphanChildren(children) {
            var tasks = [];

            for (var i in children) {
                tasks.push((function (child) {
                    if (options.withChildren) {
                        return Model.destroyById(child.id);
                    }

                    child.ancestors = [];//orphan it
                    child.parent = null;
                    return child.save();
                })(children[i]));
            }

            return Promise.all(tasks);
        }
    };

    /**
     * Grab a tree as an array (maybe coming from a frontend) and format it correctly
     * Assume (and hope) that the tree is NOT a loopback model
     * @param {array} tree
     * @param {object} options
     * @param {function} callback
     */
    Model.saveJsonTree = function (tree, options, callback) {
        if (arguments.length == 3 && typeof arguments[1] == 'object') {
            callback = arguments[2];
        } else if (arguments.length == 3) {
            callback = arguments[2];
            options = arguments[1] = {};
        } else if (arguments.length == 2 && typeof arguments[1] == 'function') {
            callback = arguments[1];
        } else if (arguments.length == 1 || arguments.length == 0) {
            options = {};
        }
        //flatten the tree
        if (!options) {
            options = {};
        }
        var flat = walk(tree),
            tasks = [];

        if (options.prependRoot) {
            return locateNode(options.prependRoot)
                .then(function (rootNode) {
                    options.prependRoot = rootNode;
                    return process(flat, options).then(function (result) {
                        if (typeof callback == 'function') {
                            callback(null, result);
                        }
                    });
                });
        }

        return process(flat, options).then(function (result) {
            if (typeof callback == 'function') {
                callback(null, result);
            }
        });

        function process(flat, options) {
            for (var i in flat) {
                //now clean it up a bit
                delete flat[i].children;
                //save it
                tasks.push(saveNode(flat[i], options));
            }

            return Promise.all(tasks).then(function () {
                    return flat;
                })
                .catch(function (err) {
                    console.log(err)
                });
        }

        function walk(nodes, level, parent, flat) {
            if (!flat) {
                flat = [];
            }

            if (!level) {
                level = 0;
            }

            if (typeof parent == 'undefined') {
                parent = null;
            }

            for (var i in nodes) {
                nodes[i].ancestors = [];

                if (parent) {
                    nodes[i].parent = parent.id;

                    for (var j in parent.ancestors) {
                        nodes[i].ancestors.push(parent.ancestors[j]);
                    }
                    nodes[i].ancestors.push(parent.id);
                    nodes[i].orderBy = i;
                }

                flat.push(nodes[i]);

                if (nodes[i].children) {
                    walk(nodes[i].children, level + 1, nodes[i], flat);
                }
            }

            return flat;
        }

        function saveNode(node, options) {
            if (!node.id) {
                return Promise.reject('no id');
            }

            //first find the actual item in the DB
            Model.findById(node.id)
                .then(function (item) {
                    item.ancestors = [];
                    //use this when your tree only came in a partial form
                    if (options.prependRoot) {
                        for (var k in options.prependRoot.ancestors) {
                            item.ancestors.push(options.prependRoot.ancestors[k]);
                        }
                        item.ancestors.push(options.prependRoot.id);
                    }

                    item.parent = (_this.toObjectID) ? _this.toObjectID(node.parent) : node.parent;
                    for (var j in node.ancestors) {
                        item.ancestors.push((_this.toObjectID) ?
                            _this.toObjectID(node.ancestors[j]) : node.ancestors[j]);
                    }

                    item.orderBy = node.orderBy;


                    return item.save();
                });
        }
    };

    function locateNodeWithCallback(node, cb) {

        var where = {};
        if (typeof node == 'string') {//Hoping on an id
            where.id = node;
        }
        else if (typeof node == 'undefined' || (typeof node == 'object' && _.isEmpty(node))) {
            return cb(null, {id: []});
        }
        else if (typeof node.id != 'undefined') {//this is the actual node model
            return cb(null, node);
        } else if (typeof node === 'object' && typeof node.id == 'undefined') {//this is a query
            where = node;
        }

        return Model.findOne({where: where}, function (err, model) {
            if (err) return cb(err);
            return cb(null, model);
        });
    }

    function locateNode(node) {

        var where = {};
        if (typeof node == 'string') {//Hoping on an id
            where.id = node;
        }
        else if (typeof node == 'undefined' || (typeof node == 'object' && _.isEmpty(node))) {
            return Promise.resolve({id: []});
        }
        else if (typeof node.id != 'undefined') {//this is the actual node model
            return Promise.resolve(node);
        } else if (typeof node === 'object' && typeof node.id == 'undefined') {//this is a query
            where = node;
        }

        return Model.findOne({where: where});
    }

    function create(node, Parent) {
        node.ancestors = createAncestorsArray(Parent);
        node.parent = Parent.id;

        return Model.create(node);
    }

    function toTree(docs, options) {
        if (typeof options == 'undefined') {
            options = {};
        }

        var tree = _.clone(docs),
            newTree = [],
            treeDepth = [];

        for (var i in tree) {
            if (!tree[i].ancestors) {
                tree[i].depth = 0;
                tree[i].ancestors = [];
                continue;
            }

            if (!tree[i].children) {
                tree[i].children = [];
            }

            tree[i].depth = tree[i].ancestors.length;
            treeDepth.push(tree[i].depth);
        }

        //this is not a valid tree
        if (treeDepth.length == 0) {
            return docs;
        }

        tree = _.sortBy(tree, 'depth');

        var maxDepth = _.max(treeDepth),
            minDepth = _.min(treeDepth);

        for (var i = 0; (maxDepth) >= i; i++) {
            var found = _.filter(tree, {depth: i});

            if ((i) == minDepth) {
                for (var a in found) {
                    found[a].children = [];
                    newTree.push(found[a]);
                }
                continue;
            }

            for (var a in found) {
                var item = _.find(tree, {id: found[a].parent});
                //format this item, add - remove - change properties
                if (typeof options.formatter == 'function') {
                    item = options.formatter(item);
                }

                if (item) {
                    if (!item.children) {
                        item.children = [];
                    }
                    item.children.push(found[a]);
                    item.children = _.sortBy(item.children, 'orderBy');
                }
            }
        }

        return (options.returnEverything) ? {tree: newTree, flat: tree} : newTree;
    }

    function deleteNode(nodeID) {
        return Model.destroyById(nodeID);
    }

    function handleErr(err) {
        return err;
    }

    function createAncestorsArray(Parent) {
        var ancestors = [];
        //add existing ancestors first
        if (Parent.ancestors) {
            for (var i in Parent.ancestors) {
                if (typeof Parent.ancestors[i] == 'object') {
                    ancestors.push(Parent.ancestors[i]);
                }
            }
        }

        ancestors.push(Parent.id);
        return ancestors
    }

    /*    Model.observe('before save', function event(ctx, next) {
     //add ancestors + parent if not there
     if (ctx.instance) { //update
     if (ctx.instance.id) {

     }
     }
     //create
     });*/

    /*    Model.observe('after delete', function event(ctx, next) {
     //orphan children cause the parent is gone
     //add ancestors + parent if not there
     if (ctx.instance) { //update
     if (ctx.instance.id) {

     }
     }
     //create
     });*/

    Model.remoteMethod('asTree', {
        accepts: [{
            arg: 'parent',
            type: 'object',
            required: true,
            http: {
                source: 'query'
            }
        },
            {
                arg: 'options',
                type: 'object',
                required: false,
                http: {
                    source: 'query'
                }
            }],
        returns: {
            arg: 'result',
            type: 'object',
            root: true
        },
        http: {
            path: '/asTree',
            verb: 'get'
        },
        description: "Returns a tree for this model"
    });

    Model.remoteMethod('addNode', {
        accepts: [{
            arg: 'parent',
            type: 'object',
            required: true,
            http: {
                source: 'query'
            }
        },
            {
                arg: 'node',
                type: 'object',
                required: true,
                http: {
                    source: 'query'
                }
            }],
        returns: {
            arg: 'result',
            type: 'string',
            root: true
        },
        http: {
            path: '/addNode',
            verb: 'put'
        },
        description: "Add a node to the tree model"
    });

    Model.remoteMethod('moveNode', {
        accepts: [{
            arg: 'node',
            type: 'object',
            required: true,
            http: {
                source: 'query'
            }
        },
            {
                arg: 'parent',
                type: 'object',
                required: true,
                http: {
                    source: 'query'
                }
            }],
        returns: {
            arg: 'result',
            type: 'string',
            root: true
        },
        http: {
            path: '/moveNode',
            verb: 'post'
        },
        description: "Move a tree node"
    });

    Model.remoteMethod('deleteNode', {
        accepts: [{
            arg: 'node',
            type: 'object',
            required: true,
            http: {
                source: 'query'
            }
        },
            {
                arg: 'options',
                type: 'object',
                required: false,
                http: {
                    source: 'query'
                }
            }],
        returns: {
            arg: 'result',
            type: 'string',
            root: true
        },
        http: {
            path: '/deleteNode',
            verb: 'delete'
        },
        description: "Delete a tree node"
    });

    Model.remoteMethod('saveJsonTree', {
        accepts: [{
            arg: 'tree',
            type: 'object',
            required: true,
            http: {
                source: 'query'
            }
        },
            {
                arg: 'options',
                type: 'object',
                required: false,
                http: {
                    source: 'query'
                }
            }],
        returns: {
            arg: 'result',
            type: 'string',
            root: true
        },
        http: {
            path: '/saveJsonTree',
            verb: 'post'
        },
        description: "Save a json tree"
    });
}

module.exports = function mixin(app) {
    app.loopback.modelBuilder.mixins.define('Tree', Tree);
};
