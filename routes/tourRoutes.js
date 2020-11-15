const express = require('express');
const tourController = require('../controllers/tourController');
// We can also apply destructuring for shorter variable names
// const { getAllTours, createTour, getTour, updateTour, deleteTour } = require('./../controllers/tourController');
const router = express.Router();

router
  .route('/top-5-cheap')
  .get(tourController.aliasTopTours, tourController.getAllTours);

router
  .route('/')
  .get(tourController.getAllTours)
  .post(tourController.createTour);
router
  .route('/:id')
  .get(tourController.getTour)
  .patch(tourController.updateTour)
  .delete(tourController.deleteTour);

module.exports = router;
