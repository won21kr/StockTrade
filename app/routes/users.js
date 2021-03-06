var async = require('async');
var bScraper = require('../../scrapers/barchartportfolioscraper');
var batslist = require('../../vendor/batslist');
var yrtScraper = require('../../scrapers/yahoorealtimescraper');
var stockDictionaryExchange = require('../../vendor/stockdictionaryexchange');
var stockDictionary = require('../../vendor/stockdictionary');
var emailCheck = require('email-check');
var bcrypt = require('bcrypt-nodejs');

var saveUser = function(user, firstName, lastName, password, email, username, bot, TransactionList, res) {
  user.firstName = firstName;
  user.lastName = lastName;
  user.username = username;
  user.password = password;
  user.email = email;
  user.botAccount = bot;

  // callback
  user.save(function (err) {
        if (err) {
          return res.status(400).json({success: false, message : "Username or email not unique"});
        } else {
          var tl = new TransactionList();
          tl.username = username;
          tl.save(function (err) {
            if (err) {
              return res.status(400).json({success: false, message : "Username or email not unique"});
            } else {
                return res.status(200).json({message: 'User created! Welcome ' + username + '!', success: true});
            }
          });
        }
  });
}

// User Router will handle creating, deleting and accessing user data
module.exports = function (app, express, User, jwt, TransactionList, Transaction, UserAsset, currentStockCache) {
    var userRouter = express.Router();

    // POST request to '/' route does not require authentication,
    // should be allowed to create users without being logged in.
    userRouter.route('/')
        // Handle new User POST request - creates new User
        .post(function (req, res) {
            console.log("post request");
            var user = new User();
            //@TODO: ensure password strength and email validity (might also do this in the user model)
            if (req.body.password.length < 6) {
              console.log("invalid password length");
              res.json({success:false, message: "Password must contain at least six characters"});
            } else {
              emailCheck(req.body.email)
                .then(function (r) {
                  if (r == false) {
                    console.log("invalid email!!");
                    // res.json({success:false, message: "Invalid email address"});
                    return res.json({success:false, message: "Invalid email address"});
                  } else {
                      console.log("valid email");
                      saveUser(user, req.body.firstName, req.body.lastName, req.body.password, req.body.email, req.body.username, req.body.bot, TransactionList, res);
                  }
                })
                .catch(function (err) {
                  console.log(err);
                  //do nothing and just pretend everything is okay
                  saveUser(user, req.body.firstName, req.body.lastName, req.body.password, req.body.email, req.body.username, req.body.bot, TransactionList, res);
                })
              }
          });

    // Verify Token and perform authenticated check
    userRouter.use(function (req, res, next) {

        var token = req.body.token || req.query.token || req.headers['x-access-token'];

        if (token) {
            jwt.verify(token, app.get('secretKey'), function (err, decoded) {
                if (err) {
                    return res.status(403).json({success: false, message: 'Failed to authenticate token.'});
                } else {
                    // Decoded token saved into request parameters
                    req.decoded = decoded;
                    next();
                }
            });
        } else {
            // No token given
            return res.status(403).json({
                success: false,
                message: 'No token provided.'
            });
        }
    });


    // Handle users GET request - returns all users - requires Admin user
    userRouter.route('/')
        .get(function (req, res) {
            // Verify that user is admin
            if (req.decoded._doc.admin) {
                User.find(function (err, users) {
                    if (err) res.send(err);
                    res.json(users);
                });
            } else {
                res.json({success: false, message: "You do not have admin access"});
            }
        });

    // Return all of current user's data
    userRouter.route('/me')
    .get(function(req, res) {
      res.send(req.decoded._doc);
    });

    //getting a user's portfolio (profits from beginning)
    userRouter.route('/portfolio').get(function (req, res) {
      // Trigger warning: callback hell
      try {
        UserAsset.find({username: req.decoded._doc.username}, function(err, assets) {
          var tickerList = [];
          var response = {assets: []};
          var portfolioValue = 0;

          async.forEach(assets, function(asset, callback) {
            currentStockCache.get(asset.ticker.toUpperCase(), function(err, currentInfo) {
              if (err) {
                console.log(asset.ticker + " is not in the cache :(");
                tickerList.push(asset.ticker);
                callback();
              } else {
                console.log(asset.ticker + " is in the cache!");
                portfolioValue += parseFloat((asset.quantity * currentInfo.lastPrice).toFixed(2));
                response.assets.push({ticker: currentInfo.symbol.toUpperCase(),
                                      name: currentInfo.name,
                                      exchange: stockDictionaryExchange[currentInfo.symbol.toUpperCase()],
                                      quantity: asset.quantity.toFixed(0),
                                      currentPricePerShare: currentInfo.lastPrice,
                                      purchasePricePerShare: (asset.buyPrice).toFixed(2),
                                      amountSpent: (asset.buyPrice * asset.quantity).toFixed(2),
                                      currentValue: (asset.quantity * currentInfo.lastPrice).toFixed(2),
                                      todayChangeNet: currentInfo.netChange,
                                      todayTotalChangeNet: (currentInfo.netChange * asset.quantity).toFixed(2),
                                      todayChangePercent: currentInfo.percentChange,
                                      totalNetProfit: (asset.quantity * (currentInfo.lastPrice - asset.buyPrice)).toFixed(2),
                                      totalPercentProfit: ((currentInfo.lastPrice / asset.buyPrice - 1) * 100).toFixed(2)});
                callback();
              }
            });
          }, function(err) {
            if (tickerList.length == 0) {
              User.findOne({username: req.decoded._doc.username}, function(err, user) {
                console.log("found user");
                if (err) res.send(err);
                response.username = user.username;
                response.cash = user.cash.toFixed(2);
                portfolioValue += parseFloat(user.cash.toFixed(2));
                response.portfolioValue = portfolioValue.toFixed(2);
                response.grossProfit = (portfolioValue - 100000).toFixed(2);
                response.percentProfit = (((portfolioValue / 100000) - 1) * 100).toFixed(2);
                res.status(200).send(response);
              });
            }
            else {
              bScraper(tickerList, function(infoList) {
                console.log("called scraper");
                User.findOne({username: req.decoded._doc.username}, function(err, user) {
                  console.log("found user");
                  if (err) res.send(err);
                  response.username = user.username;
                  response.cash = user.cash.toFixed(2);
                  portfolioValue += parseFloat(user.cash.toFixed(2));
                  if (infoList.message) {
                    response.portfolioValue = parseFloat(portfolioValue).toFixed(2);
                    response.grossProfit = parseFloat(portfolioValue - 100000).toFixed(2);
                    response.percentProfit = parseFloat((portfolioValue / 100000 - 1) * 100).toFixed(2);
                    response.success = false;
                    response.message = infoList.message;
                    res.status(400).send(response);
                  } else {
                    async.forEach(infoList, function(currentInfo, callback) {
                      if (currentInfo !== "Error"  && currentInfo.lastPrice != null) {
                        UserAsset.find({username: user.username, ticker: currentInfo.symbol.toUpperCase()}, function(err, asset) {
                          if (currentInfo.netChange == null) {
                            currentInfo.netChange = 0;
                            currentInfo.percentChange = 0;
                          }
                          //in case not already in dictionary, adds it
                          if (typeof stockDictionary[currentInfo.symbol.toUpperCase()] == 'undefined') {
                            stockDictionary[currentInfo.symbol.toUpperCase()] = currentInfo.name;
                            stockDictionaryExchange[currentInfo.symbol.toUpperCase()] = currentInfo.exchange;
                          }
                          portfolioValue += parseFloat((asset[0].quantity * currentInfo.lastPrice).toFixed(2));
                          response.assets.push({ticker: currentInfo.symbol.toUpperCase(),
                            name: stockDictionary[currentInfo.symbol.toUpperCase()],
                            exchange: stockDictionaryExchange[currentInfo.symbol.toUpperCase()],
                            quantity: asset[0].quantity,
                            currentPricePerShare: currentInfo.lastPrice,
                            purchasePricePerShare: parseFloat(asset[0].buyPrice).toFixed(2),
                            amountSpent: parseFloat(asset[0].buyPrice * asset[0].quantity).toFixed(2),
                            currentValue: parseFloat(asset[0].quantity * currentInfo.lastPrice).toFixed(2),
                            todayChangeNet: currentInfo.netChange,
                            todayTotalChangeNet: parseFloat(currentInfo.netChange * asset[0].quantity).toFixed(2),
                            todayChangePercent: currentInfo.percentChange,
                            totalNetProfit: parseFloat(asset[0].quantity * (currentInfo.lastPrice - asset[0].buyPrice)).toFixed(2),
                            totalPercentProfit: parseFloat((currentInfo.lastPrice / asset[0].buyPrice - 1) * 100).toFixed(2)});
                        value = {
                          symbol: currentInfo.symbol.toUpperCase(),
                          name: stockDictionary[currentInfo.symbol.toUpperCase()],
                          exchange: stockDictionaryExchange[currentInfo.symbol.toUpperCase()],
                          lastPrice: parseFloat(currentInfo.lastPrice).toFixed(2),
                          netChange: parseFloat(currentInfo.netChange).toFixed(2),
                          percentChange: parseFloat(currentInfo.percentChange).toFixed(2),
                          volume: currentInfo.volume,
                          high: currentInfo.high,
                          low: currentInfo.low,
                          open: currentInfo.open
                        };
                        currentStockCache.set(currentInfo.symbol.toUpperCase(), value);
                        console.log("saved asset");
                        callback();
                        });
                      } else {
                        console.log("barchart can't handle " + currentInfo.symbol + " right now--using yahoo");
                        UserAsset.find({username: user.username, ticker: currentInfo.symbol.toUpperCase()}, function(err, asset) {
                          getYahooPrice(currentInfo.symbol, currentStockCache, function(yahooResponse) {
                            portfolioValue += parseFloat((asset[0].quantity * yahooResponse.lastPrice).toFixed(2));
                            response.assets.push({ticker: currentInfo.symbol.toUpperCase(),
                              name: stockDictionary[currentInfo.symbol.toUpperCase()],
                              exchange: stockDictionaryExchange[currentInfo.symbol.toUpperCase()],
                              quantity: asset[0].quantity,
                              currentPricePerShare: yahooResponse.lastPrice,
                              purchasePricePerShare: parseFloat(asset[0].buyPrice).toFixed(2),
                              amountSpent: parseFloat(asset[0].buyPrice * asset[0].quantity).toFixed(2),
                              currentValue: parseFloat(asset[0].quantity * yahooResponse.lastPrice).toFixed(2),
                              todayChangeNet: yahooResponse.netChange,
                              todayTotalChangeNet: parseFloat(yahooResponse.netChange * asset[0].quantity).toFixed(2),
                              todayChangePercent: yahooResponse.percentChange,
                              totalNetProfit: parseFloat(asset[0].quantity * (yahooResponse.lastPrice - asset[0].buyPrice)).toFixed(2),
                              totalPercentProfit: parseFloat((yahooResponse.lastPrice / asset[0].buyPrice - 1) * 100).toFixed(2)});
                              callback();
                          });
                        });
                      }
                    }, function(err){
                      response.portfolioValue = parseFloat(portfolioValue).toFixed(2);
                      response.grossProfit = parseFloat(portfolioValue - 100000).toFixed(2);
                      response.percentProfit = parseFloat((portfolioValue / 100000 - 1) * 100).toFixed(2);
                      response.success = true;
                      response.message = "Operation successful";
                      res.status(200).send(response);
                    });
                  }
                });
              });
            }
          });
        });
      } catch (err) {

        res.status(403).json({success: false, message: "Oops! An error occurred"});
      }
    });

    userRouter.route('/:query_username')
        // GET user data - gather user data for specific username
        .get(function (req, res) {
            // Verify that user is either admin or user to be requested
            if (req.decoded._doc.admin || req.decoded._doc.username == req.params.query_username) {
                User.findOne({username: req.params.query_username}, function (err, user) {
                    if (err) res.send(err);
                    res.status(200).json({success: false, message: "success", result: user});
                });
            } else {
                res.status(404).json({success: false, message: "You do not have access to this page."});
            }
        })

        // PUT user data - change user data for specific username
        .put(function (req, res) {

            // Break if user is not admin or user under question
            if (req.decoded._doc.admin || req.decoded._doc.username == req.params.query_username) {
                User.findOne({username: req.params.query_username}, function (err, user) {
                    if (err) res.send(err);

                    if (!user.comparePassword(req.body.password)) {
                      res.status(401).json({success: false, message: 'Password incorrect.'});

                    } else {

                      if (req.body.newPassword) user.password = req.body.newPassword;
                      if (typeof req.body.botAccount !== "undefined") user.botAccount = req.body.botAccount;
                      if (req.body.firstName) user.firstName = req.body.firstName;
                      if (req.body.lastName) user.lastName = req.body.lastName;
                      user.save(function (err) {
                          if (err) {
                            res.send(err);
                          } else {

                            var token = jwt.sign(user, app.get('secretKey'), {
                              expiresIn: 60*60*24*365*10 // expires in ten years
                            });
                            res.status(200).json({success: true, message: 'User updated!', token: token});
                          }
                      });
                    }
                });
            } else {
                res.status(404).json({success: false, message: "You cannot change this user's information"});
            }
        })


        // DELETE user - delete user for specific username
        .delete(function (req, res) {

            // Break if user is not admin or user under question
            if (req.decoded._doc.admin || req.decoded._doc.username == req.params.query_username) {
                User.remove({username: req.params.query_username}, function (err, user) {
                    if (err) res.send(err);
                    res.status(200).json({success: true, message: 'User ' + req.params.query_username + ' successfully deleted'});
                });
            } else {
                res.status(404).json({success: false, message: "You do not have access to this page"});
            }
        });

    /* Below are routes configured for buying and selling stocks
     */

    userRouter.route('/buy/:stock_symbol/:quantity')

        //sends info on the transaction, but does not process it
        .get(function (req, res) {
          try {
          //stock does not exist
            if (batslist.indexOf(req.params.stock_symbol.toUpperCase()) < 0) {
              res.status(404).json({success: false, message: "The stock you attempted to buy does not exist"});
            } else if (isNaN(parseInt(req.params.quantity)) || parseInt(req.params.quantity) <= 0){
              res.status(404).json({success: false, message: "You cannot buy at a non-whole number quantity"});
            } else {
              User.findOne({username: req.decoded._doc.username}, function (err, user) {
                  if (err) res.send(err);
                  if (req.params.quantity <= 0) {
                    res.json({success: false, message: "Quantity must be greater than 0"});
                  } else {
                    UserAsset.find({username: req.decoded._doc.username}, function(err, assetList) {
                      if (assetList.length >= 200) {
                        res.json({message: "You cannot own more than 200 stocks", success: false});
                      } else {
                          getYahooPrice(req.params.stock_symbol, currentStockCache, function(info) {
                            if(parseFloat((req.params.quantity * info.lastPrice).toFixed(2)) > user.cash) {
                              res.json({success: false, message: "You do not have enough money to make this purchase"});
                            } else {
                              res.status(200).json({
                                message: "GET Success",
                                amount: req.params.quantity,
                                costPerShare: info.lastPrice,
                                totalCost: parseFloat(info.lastPrice * req.params.quantity).toFixed(2),
                                success: true
                              });
                            }
                          });
                      }
                    });
                  }
              });
            }
          } catch (err) {

            res.status(403).json({success: false, message: "Oops! An error occurred"});
          }
        })

        //performs the act of buying a stock
        // Arda's most disgusting block of code ever :) (jk now it's portfolio)
        .post(function (req, res) {
          try {
            if (batslist.indexOf(req.params.stock_symbol.toUpperCase()) < 0) {
              res.json({sucess: false, message: "The stock you attempted to buy does not exist"});
            } else if (isNaN(parseInt(req.params.quantity)) || parseInt(req.params.quantity) <= 0){
              res.status(404).json({success: false, message: "You cannot buy at a non-whole number quantity"});
            } else {
                User.findOne({username: req.decoded._doc.username}, function (err, user) {
                    if (err) res.send(err);
                    else if (req.params.quantity <= 0) {
                      res.json({message: "Quantity must be greater than 0", success: false});
                    } else {
                      console.log("found user");
                      UserAsset.find({username: req.decoded._doc.username}, function(err, assetList) {
                        if (assetList.length >= 200) {
                          res.json({message: "You cannot own more than 200 stocks", success: false});
                        } else {
                          getYahooPrice(req.params.stock_symbol, currentStockCache, function(info) {
                            console.log("found price");
                            if(parseFloat((req.params.quantity * info.lastPrice).toFixed(2)) > user.cash) {
                              res.json({message: "You do not have enough money to make this purchase", success: false});
                            } else {
                              UserAsset.findOne({username: req.decoded._doc.username, ticker: req.params.stock_symbol.toUpperCase()}, function(err, asset) {
                                if (err) {
                                  res.send(err);
                                } else {
                                  //doesn't exist yet
                                  if (asset === null) {
                                    var asset = new UserAsset();
                                    asset.ticker = req.params.stock_symbol.toUpperCase();
                                    asset.quantity = req.params.quantity;
                                    asset.buyPrice = info.lastPrice;
                                    asset.username = req.decoded._doc.username;
                                  } else {
                                    asset.buyPrice = parseFloat(((info.lastPrice * parseInt(req.params.quantity) + asset.buyPrice * asset.quantity) / (asset.quantity + parseInt(req.params.quantity))).toFixed(2));
                                    asset.quantity += parseInt(req.params.quantity);
                                  }
                                }
                                asset.save(function(err) {
                                  if (err) {
                                    res.send(err);
                                  } else {
                                    console.log("saved asset");
                                    user.cash -= parseFloat((req.params.quantity * info.lastPrice).toFixed(2));
                                    user.save(function (err) {
                                        if (err) {
                                          res.send(err);
                                        } else {
                                          TransactionList.findOne({username: req.decoded._doc.username}, function(err, list) {
                                            list.transactions.push(new Transaction({
                                              stockTicker: req.params.stock_symbol.toUpperCase(),
                                              type: "Buy",
                                              num_shares: req.params.quantity,
                                              pricePerShare: info.lastPrice,
                                              totalPrice: (req.params.quantity * info.lastPrice),
                                              username: req.decoded._doc.username
                                            }));

                                            list.save(function (err) {
                                              if (err) {
                                                res.send(err);
                                              } else {
                                                console.log("saved transaction");
                                                res.json({
                                                  success: true,
                                                  message: "POST Success",
                                                  quantity: req.params.quantity,
                                                  costPerShare: info.lastPrice,
                                                  totalCost: parseFloat(info.lastPrice * req.params.quantity).toFixed(2)
                                                });
                                              }
                                            });
                                          });
                                        }
                                    });
                                  }
                                });
                              });
                            }
                          });
                        }
                      });
                    }
                });
              }
            } catch (err) {

              res.status(403).json({success: false, message: "Oops! An error occurred"});
            }
        });

    userRouter.route('/sell/:stock_symbol/:quantity')

        //sends info on the transaction, but does not process it
        .get(function (req, res) {
          try {
            if (isNaN(parseInt(req.params.quantity)) || parseInt(req.params.quantity) <= 0){
              res.status(404).json({success: false, message: "You cannot sell at a non-whole number quantity"});
            } else {
              User.findOne({username: req.decoded._doc.username}, function(err, user) {
                if (err) {
                  res.send(err);
                } else if (req.params.quantity <= 0) {
                    res.json({success: false, message: "Quantity must be greater than 0"});
                } else {
                  UserAsset.findOne({username: req.decoded._doc.username, ticker: req.params.stock_symbol.toUpperCase()}, function(err, asset) {
                    if (err) {res.send(err);}
                    else if (asset === null) {
                      res.json({success: false, message: "You do not own this stock, so you cannot sell it"});
                    } else if (asset.quantity < req.params.quantity) {
                      res.json({success: false, message: "You do not own as many of this stock as you are attempting to sell"});
                    } else {
                      getYahooPrice(req.params.stock_symbol, currentStockCache, function(info) {
                        res.json({
                          success: true,
                          message: "GET Success",
                          quantity: req.params.quantity,
                          revenuePerShare: info.lastPrice,
                          totalRevenue: parseFloat(info.lastPrice * req.params.quantity).toFixed(2)
                        });
                      });
                    }
                  });
                }
              });
            }
          } catch (err) {

            res.status(403).json({success: false, message: "Oops! An error occurred"});
          }
        })

        //performs the act of buying a stock
        .post(function (req, res) {
          try {
            if (isNaN(parseInt(req.params.quantity)) || parseInt(req.params.quantity) <= 0){
              res.status(404).json({success: false, message: "You cannot sell at a non-whole number quantity"});
            } else {
              User.findOne({username: req.decoded._doc.username}, function (err, user) {
                if (err) {
                  res.send(err);
                } else if (req.params.quantity <= 0) {
                    res.json({message: "Quantity must be greater than 0"});
                } else {
                  UserAsset.findOne({username: req.decoded._doc.username, ticker: req.params.stock_symbol.toUpperCase()}, function(err, asset) {
                    if (err) {res.send(err);}
                    else if (asset === null) {
                      res.json({success: false, message: "You do not own this stock, so you cannot sell it"});
                    } else if (asset.quantity < req.params.quantity) {
                      res.json({success: false, message: "You do not own as many of this stock as you are attempting to sell"});
                    } else {
                      getYahooPrice(req.params.stock_symbol, currentStockCache, function(info) {
                        var prevQuantity = asset.quantity;
                        var prevPrice = asset.buyPrice;
                        if (asset.quantity === parseInt(req.params.quantity)) {
                          asset.remove(function(err) {
                            sellHelper(err, user, info, res, req, prevQuantity, prevPrice, TransactionList, Transaction);
                          });
                        } else {
                          asset.quantity -= parseInt(req.params.quantity);
                          asset.save(function (err) {
                            sellHelper(err, user, info, res, req, prevQuantity, prevPrice, TransactionList, Transaction);
                          });
                        }
                      });
                    }
                  });
                }
              });
            }
          } catch (err) {

            res.status(403).json({success: false, message: "Oops! An error occurred"});
          }
        });

    //for handling requests to /users/transactions (listing transactions)
    require('./transactions')(app, express, User, jwt, Transaction, userRouter);
    app.use('/users', userRouter);
};

// helper for sell POST route (so I don't have to copy paste the same thing)
var sellHelper = function(err, user, info, res, req, prevQuantity, prevPrice, TransactionList, Transaction) {
  if (err) {
    res.send(err);
  } else {
    user.cash += parseFloat((info.lastPrice * req.params.quantity).toFixed(2));
    user.save(function(err) {
      if (err) {
        res.send(err);
      } else {
        TransactionList.findOne({username: req.decoded._doc.username}, function(err, list) {
          list.transactions.push(new Transaction({
            stockTicker: req.params.stock_symbol.toUpperCase(),
            type: "Sell",
            num_shares: req.params.quantity,
            pricePerShare: info.lastPrice ,
            totalPrice: req.params.quantity * info.lastPrice,
            username: req.decoded._doc.username,
            percentProfit: (info.lastPrice  / prevPrice - 1) * 100
          }));

          list.save(function (err) {
            if (err) {
              res.send(err);
            } else {
              res.json({
                success: true,
                message: "POST Success",
                quantity: req.params.quantity,
                revenuePerShare: info.lastPrice ,
                totalRevenue: parseFloat(info.lastPrice  * req.params.quantity).toFixed(2)
              });
            }
          });
        });
      }
    });
  }
};

var getYahooPrice = function(symbol, stockCache, callback) {
    stockCache.get(symbol.toUpperCase(), function(err, value) {
      if (err) {
        console.log("not in cache");
        yrtScraper(symbol, function(info) {
          //create object to put in cache
          //price, change, change in percent, open, close, high, low and volume
          value = {
            symbol: symbol.toUpperCase(),
            name: stockDictionary[symbol.toUpperCase()],
            exchange: stockDictionaryExchange[symbol.toUpperCase()],
            lastPrice: parseFloat(info[0][0]).toFixed(2),
            netChange: parseFloat(info[0][1]).toFixed(2),
            percentChange: parseFloat(info[0][2].substring(0, info[0][2].length - 1)).toFixed(2), // strips % sign
            volume: parseInt(info[0][7]),
            high: parseFloat(parseFloat(info[0][5]).toFixed(2)),
            low: parseFloat(parseFloat(info[0][6]).toFixed(2)),
            open: parseFloat(parseFloat(info[0][3]).toFixed(2))
          };
          //save in cache
          stockCache.set(symbol.toUpperCase(), value);

          //callback on object
          callback(value);
        });
      } else {
        console.log("in cache");
        callback(value);
      }
    });
};
