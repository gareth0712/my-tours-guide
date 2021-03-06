const crypto = require('crypto');
const { promisify } = require('util');
const jwt = require('jsonwebtoken');
const User = require('../models/userModel');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const sendEmail = require('../utils/email');

const signToken = (id) => {
  // secret needs to be 32-char long
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN,
  });
};

const createSendToken = (user, statusCode, res) => {
  const token = signToken(user._id);
  const cookieOptions = {
    expires: new Date(
      Date.now() + process.env.JWT_COOKIE_EXPIRES_IN * 60 * 1000
    ), // Client's browser will delete the cookie after it has expired
    httpOnly: true, // Can only be accessed by web server
  };

  // Cookie will only be sent in HTTPS; If not https, cookie will not be created or sent to client
  if (process.env.NODE_ENV === 'production') cookieOptions.secure = true;

  // Send the cookie
  res.cookie('jwt', token, cookieOptions);

  // Remove password from response but not remove in database
  user.password = undefined;

  res.status(statusCode).json({
    status: 'success',
    token,
    data: {
      user,
    },
  });
};

exports.signup = catchAsync(async (req, res, next) => {
  const newUser = await User.create({
    // We can also use User.save to update the user
    // Instead of .create(req.body), using the following avoid users set themselves as admin via the req.body
    name: req.body.name,
    email: req.body.email,
    password: req.body.password,
    passwordConfirm: req.body.passwordConfirm,
  });

  createSendToken(newUser, 201, res);
});

exports.login = catchAsync(async (req, res, next) => {
  const { email, password } = req.body;

  // 1) Check if email and password exist
  if (!email || !password) {
    // If without the return keyword, it will send two responses
    return next(new AppError('Please provide email and password!', 400));
  }
  // 2) check if user exists & password is correct
  // find will not return password and so we need to explicitly get password with select()
  // Without the plus('+') sign, it will then only return the password field
  const user = await User.findOne({ email }).select('+password');
  // instance method is available for all the documents
  if (!user || !(await user.correctPassword(password, user.password))) {
    // 401 means unauthorized
    return next(new AppError('Incorrect email or password'), 401);
  }

  // 3) If everything ok, send token to client
  createSendToken(user, 200, res);
});

exports.protect = catchAsync(async (req, res, next) => {
  let token;
  // 1) Getting token and check if it exists
  if (
    // Tokens in req header
    // { authorization: 'Bearer o3j2ofsnvlks!', ... }
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return next(
      new AppError('You are not logged in! Please log in to get access.', 401)
    );
  }
  // 2) Verification of token: Whether token is manipulated / expired
  // jwt.verify is a asynchoronous function that will run the callback func after finish verification, i.e. jwt.verify(token, secret, callback)
  // without supplying a callback, it is a synchoronous function
  // To avoid breaking our pattern of using async/await + promises all the time, we promisify it so that we can use async/await on it
  // promisify(jwt.verify) becomes a promise and takes the following arguments to resolve it
  const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET);
  console.log(decoded);

  // 3) Check if user still exists
  // Need to tackle if the user gets deleted after token is issued
  const user = await User.findById(decoded.id);
  if (!user)
    return next(
      new AppError('The user belonging to this token no longer exists ', 401)
    );

  // 4) Check if user changed password after the JWT was issued
  // If someone stole user account and use it. User then changed password to stop him using the account. The JWT issued before the password change should become invalid
  if (user.changedPasswordAfter(decoded.iat)) {
    return next(
      new AppError('User recently changed password. Please log in again', 401)
    );
  }

  // Grant access to protected route
  req.user = user;
  next();
});

exports.restrictTo = (...roles) => {
  return (req, res, next) => {
    // roles ['admin', 'lead-guide']. role='user'
    if (!roles.includes(req.user.role)) {
      return next(
        new AppError('You do not have permission to perform this action', 403)
      );
    }

    next();
  };
};

exports.forgotPassword = catchAsync(async (req, res, next) => {
  // 1) Get user based on POSTed email
  const user = await User.findOne({ email: req.body.email });
  if (!user) {
    return next(new AppError('There is no user with that email address.', 404));
  }

  // 2) Generate the random reset token
  const resetToken = user.createPasswordResetToken();
  console.log(`resetToken: ${user.passwordResetToken}`);
  console.log(`resetExpire: ${user.passwordResetExpires}`);
  // Save the reset pw token and expires time to MongoDB
  await user.save({ validateBeforeSave: false });
  console.log('Saved!');

  // 3) Send it to user's email
  const resetURL = `${req.protocol}://${req.get(
    'host'
  )}/api/v1/users/resetPassword/${resetToken}`;

  const message = `Forgot your password? Submit a PATCH request with your new password and passwordConfirm to: ${resetURL}.\nIf you didn't forget your password, please ignore this email!`;

  // catchAsync will merely put the error to global error handler
  // In this case, if email cannot be sent, we need to forfeit the password reset token
  try {
    await sendEmail({
      email: user.email,
      subject: 'Your password reset token (Valid for 10 minutes)',
      message,
    });

    res.status(200).json({
      status: 'success',
      message: 'Token sent to user email',
    });
  } catch (e) {
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save({ validateBeforeSave: false });

    console.log(e);

    return next(
      new AppError('There was an error sending the email. Try again later!'),
      500
    );
  }
});

exports.resetPassword = catchAsync(async (req, res, next) => {
  // 1) Get user based on the token
  const hashedToken = crypto
    .createHash('sha256')
    .update(req.params.token)
    .digest('hex');

  const user = await User.findOne({
    passwordResetToken: hashedToken,
    passwordResetExpires: { $gt: Date.now() },
  });

  // 2) If token has not expired + user exists, set the new password
  if (!user) {
    return next(new AppError('Token is invalid or has expired', 400));
  }

  user.password = req.body.password;
  user.passwordConfirm = req.body.passwordConfirm;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  await user.save(); // Use save in order to run all validations and the pre-save middleware

  // 3) Update changePasswordAt property for user
  // Implement pre-save middleware to do this

  // 4) Log the user in, send JWT
  createSendToken(user, 200, res);
});

exports.updatePassword = catchAsync(async (req, res, next) => {
  // 1) Get user from collection
  const user = await User.findById(req.user.id).select('+password');

  // 2) Check if POSTed current password is correct
  if (!(await user.correctPassword(req.body.currentPassword, user.password))) {
    return next(new AppError('Your current password is wrong'), 401);
  }

  // 3) If so, update password
  user.password = req.body.newPassword;
  user.passwordConfirm = req.body.newPasswordConfirm;
  await user.save(); // If we use user.findByIdAndUpdate(), it won't trigger the validator nor the pre-save middleware that encrypts the new password

  // Log user in, send JWT
  createSendToken(user, 200, res);
});
