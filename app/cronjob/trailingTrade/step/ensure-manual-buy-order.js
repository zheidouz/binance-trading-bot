/* eslint-disable no-await-in-loop */
const moment = require('moment');
const _ = require('lodash');
const { cache, PubSub, binance, slack } = require('../../../helpers');
const {
  calculateLastBuyPrice,
  getAPILimit,
  saveOrder
} = require('../../trailingTradeHelper/common');

/**
 * Send slack message for order filled
 *
 * @param {*} logger
 * @param {*} symbol
 * @param {*} side
 * @param {*} orderParams
 * @param {*} orderResult
 */
const slackMessageOrderFilled = async (
  logger,
  symbol,
  side,
  orderParams,
  orderResult
) => {
  const type = orderParams.type.toUpperCase();

  PubSub.publish('frontend-notification', {
    type: 'success',
    title: `The ${side} order for ${symbol} has been executed successfully.`
  });

  return slack.sendMessage(
    `${symbol} Manual ${side.toUpperCase()} Order Filled (${moment().format(
      'HH:mm:ss.SSS'
    )}): *${type}*\n` +
      `- Order Result: \`\`\`${JSON.stringify(
        orderResult,
        undefined,
        2
      )}\`\`\`\n` +
      `- Current API Usage: ${getAPILimit(logger)}`
  );
};

/**
 * Send slack message for order deleted
 *
 * @param {*} logger
 * @param {*} symbol
 * @param {*} side
 * @param {*} orderParams
 * @param {*} orderResult
 */
const slackMessageOrderDeleted = async (
  logger,
  symbol,
  side,
  orderParams,
  orderResult
) => {
  const type = orderParams.type.toUpperCase();

  PubSub.publish('frontend-notification', {
    type: 'success',
    title: `The ${side} order for ${symbol} is ${orderResult.status}. Stop monitoring.`
  });

  return slack.sendMessage(
    `${symbol} Manual ${side.toUpperCase()} Order Removed (${moment().format(
      'HH:mm:ss.SSS'
    )}): *${type}*\n` +
      `- Order Result: \`\`\`${JSON.stringify(
        orderResult,
        undefined,
        2
      )}\`\`\`\n` +
      `- Current API Usage: ${getAPILimit(logger)}`
  );
};

/**
 * Ensure manual buy order is placed
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  const {
    symbol,
    symbolConfiguration: {
      system: { checkManualBuyOrderPeriod }
    }
  } = data;

  const manualBuyOrders = await cache.hgetall(
    `trailing-trade-manual-buy-order-${symbol}`
  );

  if (_.isEmpty(manualBuyOrders) === true) {
    logger.info(
      { manualBuyOrders },
      'Could not find manual buy order, do not process ensure-manual-buy-order.'
    );
    return data;
  }

  const removeStatuses = ['CANCELED', 'REJECTED', 'EXPIRED', 'PENDING_CANCEL'];

  // Check if manual-buy-order is existing
  // eslint-disable-next-line no-restricted-syntax
  for (const rawBuyOrder of Object.values(manualBuyOrders)) {
    const buyOrder = JSON.parse(rawBuyOrder);
    logger.info({ buyOrder }, 'Start checking buy order');
    // If filled already, then calculate average price and save
    if (buyOrder.status === 'FILLED') {
      logger.info(
        { buyOrder },
        'Order has already filled, calculate last buy price.'
      );
      await calculateLastBuyPrice(logger, symbol, buyOrder);
      await cache.hdel(
        `trailing-trade-manual-buy-order-${symbol}`,
        buyOrder.orderId
      );

      // Save order
      await saveOrder(logger, {
        order: { ...buyOrder },
        botStatus: {
          savedAt: moment().format(),
          savedBy: 'ensure-manual-buy-order',
          savedMessage:
            'The order has already filled and updated the last buy price.'
        }
      });
    } else {
      // If not filled, check orders is time to check or not

      const nextCheck = _.get(buyOrder, 'nextCheck', null);

      if (moment(nextCheck) < moment()) {
        // Check orders whether it's filled or not
        let orderResult;
        try {
          orderResult = await binance.client.getOrder({
            symbol,
            orderId: buyOrder.orderId
          });
        } catch (e) {
          logger.error(
            { e },
            'The order could not be found or error occurred querying the order.'
          );
          const updatedNextCheck = moment().add(
            checkManualBuyOrderPeriod,
            'seconds'
          );

          logger.info(
            {
              e,
              buyOrder,
              checkManualBuyOrderPeriod,
              nextCheck: updatedNextCheck
            },
            'The order could not be found or error occurred querying the order.'
          );

          await cache.hset(
            `trailing-trade-manual-buy-order-${symbol}`,
            buyOrder.orderId,
            JSON.stringify({
              ...buyOrder,
              nextCheck: updatedNextCheck
            })
          );

          // Save order
          await saveOrder(logger, {
            order: { ...buyOrder },
            botStatus: {
              savedAt: moment().format(),
              savedBy: 'ensure-manual-buy-order',
              savedMessage:
                'The order could not be found or error occurred querying the order.'
            }
          });

          return data;
        }

        // If filled, then calculate average cost and quantity and save new last buy pirce.
        if (orderResult.status === 'FILLED') {
          logger.info(
            { buyOrder },
            'The order is filled, caluclate last buy price.'
          );
          slackMessageOrderFilled(
            logger,
            symbol,
            buyOrder.side,
            buyOrder,
            orderResult
          );
          await calculateLastBuyPrice(logger, symbol, orderResult);

          // Remove manual buy order
          await cache.hdel(
            `trailing-trade-manual-buy-order-${symbol}`,
            orderResult.orderId
          );

          // Save order
          await saveOrder(logger, {
            order: { ...buyOrder, ...orderResult },
            botStatus: {
              savedAt: moment().format(),
              savedBy: 'ensure-manual-buy-order',
              savedMessage:
                'The order has filled and updated the last buy price.'
            }
          });
        } else if (removeStatuses.includes(orderResult.status) === true) {
          // If order is no longer available, then delete from cache
          await cache.hdel(
            `trailing-trade-manual-buy-order-${symbol}`,
            orderResult.orderId
          );

          // Save order
          await saveOrder(logger, {
            order: { ...buyOrder, ...orderResult },
            botStatus: {
              savedAt: moment().format(),
              savedBy: 'ensure-manual-buy-order',
              savedMessage:
                'The order is no longer valid. Removed from the cache.'
            }
          });

          slackMessageOrderDeleted(
            logger,
            symbol,
            buyOrder.side,
            buyOrder,
            orderResult
          );
        } else {
          // If not filled, update next check time
          const updatedNextCheck = moment().add(
            checkManualBuyOrderPeriod,
            'seconds'
          );

          logger.info(
            {
              orderResult,
              checkManualBuyOrderPeriod,
              nextCheck: updatedNextCheck
            },
            'The order is not filled, update next check time.'
          );

          await cache.hset(
            `trailing-trade-manual-buy-order-${symbol}`,
            orderResult.orderId,
            JSON.stringify({
              ...orderResult,
              nextCheck: updatedNextCheck
            })
          );

          // Save order
          await saveOrder(logger, {
            order: { ...orderResult },
            botStatus: {
              savedAt: moment().format(),
              savedBy: 'ensure-manual-buy-order',
              savedMessage: 'The order is not filled. Check next internal.'
            }
          });
        }
      } else {
        logger.info(
          { buyOrder, nextCheck, currentTime: moment() },
          'Skip checking the order'
        );
      }
    }
  }

  return data;
};

module.exports = { execute };
